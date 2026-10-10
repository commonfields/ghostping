import { Effect, Schema } from "effect"
import { GeminiModel, NineRouterConnectionConfig, NineRouterEnabled, RecordSurfaceConfig } from "@openrecord/config"
import { HOSTED_PROVIDER_CAPABILITIES, ProviderCatalogResponse, type ProviderInfo } from "@openrecord/contracts"

/** Reads non-secret API configuration only. A declaration is not a live
 * connectivity check, and worker-only credentials are never required here. */
export const loadProviderCatalog = (assaySyntheticEnabled: boolean, recordFixturesAllowed: boolean) => Effect.gen(function*() {
  const nine = yield* Effect.either(Effect.gen(function*() {
    if (!(yield* NineRouterEnabled)) return null
    return yield* NineRouterConnectionConfig
  }))
  const gemini = yield* Effect.either(GeminiModel)
  const record = yield* Effect.either(RecordSurfaceConfig)
  const recordProvider = record._tag === "Right" ? record.right.provider : null
  const providers: ProviderInfo[] = [
    {
      id: "mock", enabled: true, models: [], configurationStatus: "DECLARED", workerAvailability: "UNKNOWN",
      workflows: ["checks", "assay", ...(recordProvider === "mock" && recordFixturesAllowed ? ["record" as const] : [])],
      capabilities: HOSTED_PROVIDER_CAPABILITIES.mock,
    },
    {
      id: "9router", enabled: nine._tag === "Right" && nine.right !== null,
      models: nine._tag === "Right" && nine.right !== null ? nine.right.models : [],
      configurationStatus: nine._tag === "Left" ? "INVALID" : nine.right === null ? "DISABLED" : "DECLARED",
      workerAvailability: "UNKNOWN", workflows: ["checks", "assay"], capabilities: HOSTED_PROVIDER_CAPABILITIES["9router"],
    },
    {
      id: "gemini", enabled: gemini._tag === "Right" && recordProvider === "gemini",
      models: gemini._tag === "Right" ? [gemini.right] : [],
      configurationStatus: gemini._tag === "Left" || record._tag === "Left" ? "INVALID" : recordProvider === "gemini" ? "DECLARED" : "DISABLED",
      workerAvailability: "UNKNOWN", workflows: ["record"], capabilities: HOSTED_PROVIDER_CAPABILITIES.gemini,
    },
  ]
  // Validate the public allowlist; no endpoint, key, error text, or raw
  // configuration object may escape through this contract.
  return yield* Schema.encode(ProviderCatalogResponse)({ providers, assaySyntheticEnabled })
})
