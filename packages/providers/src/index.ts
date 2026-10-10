import { Effect, Layer, Schema } from "effect"
import { HOSTED_PROVIDER_CAPABILITIES, HOSTED_PROVIDER_IDS } from "@openrecord/contracts"
import { GeminiProvider, MockProvider, NineRouterProvider, ProviderContractMismatch, ProviderRegistry, ProviderRequest, ProviderUnsupported } from "./model.js"
export * from "./model.js"
export * from "./mock.js"
export * from "./nine-router.js"
export * from "./gemini.js"
export const SUPPORTED_HOSTED_PROVIDERS = HOSTED_PROVIDER_IDS
export { HOSTED_PROVIDER_CAPABILITIES } from "@openrecord/contracts"
export type HostedProvider = (typeof SUPPORTED_HOSTED_PROVIDERS)[number]
export const isSupportedProvider = (p: string): p is HostedProvider => (SUPPORTED_HOSTED_PROVIDERS as ReadonlyArray<string>).includes(p)
export const ProviderRegistryLive = Layer.effect(ProviderRegistry, Effect.gen(function*() {
  const mock = yield* MockProvider
  const nine = yield* NineRouterProvider
  // Optional so existing two-adapter layers keep working; absent = unsupported.
  const gemini = yield* Effect.serviceOption(GeminiProvider)
  const adapters = new Map([["mock", mock], ["9router", nine], ...(gemini._tag === "Some" ? [["gemini", gemini.value] as const] : [])])
  return { observe: (request) => Effect.gen(function*() {
    const input = yield* Schema.decodeUnknown(ProviderRequest, { onExcessProperty: "error" })(request).pipe(Effect.mapError(() => new ProviderContractMismatch({})))
    const adapter = adapters.get(input.provider)
    if (!adapter || !isSupportedProvider(input.provider)) return yield* Effect.fail(new ProviderUnsupported({}))
    const capabilities = HOSTED_PROVIDER_CAPABILITIES[input.provider]
    if (input.retrievalMode !== undefined && !capabilities.acceptedRetrievalModes.includes(input.retrievalMode)) {
      return yield* Effect.fail(new ProviderUnsupported({}))
    }
    return yield* adapter.observe(input)
  }) }
}))
