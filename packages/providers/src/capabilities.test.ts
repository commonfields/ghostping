import { describe, expect, it } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { AnswerSurfaceCapabilitiesV1 } from "@openrecord/contracts"
import { GeminiProvider, HOSTED_PROVIDER_CAPABILITIES, MockProviderLive, NineRouterProvider, ProviderRegistry, ProviderRegistryLive, ProviderUnsupported } from "./index.js"

describe("hosted adapter capability boundary", () => {
  it("declares valid descriptors and preserves provenance asymmetry", () => {
    for (const capabilities of Object.values(HOSTED_PROVIDER_CAPABILITIES)) {
      expect(Schema.decodeUnknownEither(AnswerSurfaceCapabilitiesV1)(capabilities)._tag).toBe("Right")
    }
    expect(HOSTED_PROVIDER_CAPABILITIES.mock.synthetic).toBe(true)
    expect(HOSTED_PROVIDER_CAPABILITIES["9router"].provenance.retrievalExecutionReporting).toBe("UNKNOWN")
    expect(HOSTED_PROVIDER_CAPABILITIES.gemini.provenance.answerSpanAttribution).toBe("UNSUPPORTED")
    expect(HOSTED_PROVIDER_CAPABILITIES.gemini.determinism).toBe("UNKNOWN")
  })

  it("rejects undeclared retrieval modes before invoking an adapter", async () => {
    let calls = 0
    const observe = () => { calls++; return Effect.fail(new ProviderUnsupported({})) }
    const layer = ProviderRegistryLive.pipe(Layer.provide(Layer.mergeAll(MockProviderLive, Layer.succeed(NineRouterProvider, { observe }), Layer.succeed(GeminiProvider, { observe }))))
    for (const [provider, retrievalMode] of [["9router", "WEB_SEARCH"], ["gemini", "NONE"], ["gemini", "MANUAL_CAPTURE"]] as const) {
      const result = await Effect.runPromise(Effect.flatMap(ProviderRegistry, r => r.observe({ runId: "TEST-run", provider, requestedModel: "TEST-model", prompt: "TEST", retrievalMode })).pipe(Effect.provide(layer), Effect.either))
      expect(result._tag === "Left" && result.left._tag).toBe("ProviderUnsupported")
    }
    expect(calls).toBe(0)
  })

  it("refuses unknown request controls instead of silently dropping them", async () => {
    let calls = 0
    const layer = ProviderRegistryLive.pipe(Layer.provide(Layer.mergeAll(MockProviderLive, Layer.succeed(NineRouterProvider, {
      observe: () => { calls++; return Effect.fail(new ProviderUnsupported({})) },
    }))))
    for (const control of [{ seed: 123 }, { systemPrompt: "TEST" }, { temperature: 0 }]) {
      const result = await Effect.runPromise(Effect.flatMap(ProviderRegistry, r => r.observe({ runId: "TEST-run", provider: "9router", requestedModel: "TEST-model", prompt: "TEST", ...control })).pipe(Effect.provide(layer), Effect.either))
      expect(result._tag === "Left" && result.left._tag).toBe("ProviderContractMismatch")
    }
    expect(calls).toBe(0)
  })
})
