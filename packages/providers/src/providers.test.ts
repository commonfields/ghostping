import { describe, expect, it } from "vitest"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { Effect, Layer, Redacted, Schema } from "effect"
import { NineRouterSettings, type NineRouterSettingsValue } from "@ghostping/config"
import {
  MockProvider, MockProviderLive, NineRouterProvider, NineRouterProviderLive, ProviderRegistry, ProviderRegistryLive,
  ProviderRequest, ProviderUnsupported, isRetryableProviderError, sha256,
} from "./index.js"
const input = { runId: "run-1", provider: "9router", requestedModel: null, prompt: "test prompt" }
const settings: NineRouterSettingsValue = { baseUrl: Redacted.make("http://localhost/v1"), apiKey: Redacted.make("test-only-key"), model: "pin", timeoutMs: 1000, responseMaxBytes: 2048 }
const body = ' { "model":"actual", "choices":[{"message":{"content":"answer"}}], "citations":["https://example.test",{"uri":"https://other.test","title":"source","position":9,"attributed":true}], "usage":{"total_tokens":3}, "native_extra":1 }\n'
const invoke = (text: string, status = 200, cfg = settings, headers: Record<string, string> = { "content-type": "application/provider+json" }) => {
  let captured: unknown
  const client = HttpClient.make(request => {
    captured = request
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(text, { status, headers })))
  })
  const layer = NineRouterProviderLive.pipe(Layer.provide(Layer.succeed(NineRouterSettings, cfg)), Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))
  return { result: Effect.runPromise(Effect.gen(function*() { return yield* (yield* NineRouterProvider).observe(input) }).pipe(Effect.provide(layer), Effect.either)), captured: () => captured }
}
describe("Effect provider boundary", () => {
  it("captures request mapping and exact response evidence before Schema decoding", async () => {
    const call = invoke(body)
    const result = await call.result
    expect(result._tag).toBe("Right")
    if (result._tag !== "Right") throw new Error("expected success")
    const r = result.right
    expect(r.requestedModel).toBe("pin")
    expect(r.observedModel).toBe("actual")
    expect(r.answerText).toBe("answer")
    expect(r.retrievalMode).toBe("unknown")
    expect(r.synthetic).toBe(false)
    expect(r.rawDigest).toBe(sha256(new TextEncoder().encode(body)))
    expect(r.rawDigest).not.toBe(sha256(new TextEncoder().encode(JSON.stringify(r.rawResponse))))
    expect(new TextDecoder().decode(r.rawBytes)).toBe(body)
    expect(r.rawContentType).toBe("application/provider+json")
    expect(r.citations).toEqual([{ uri: "https://example.test", title: null, position: 1, attributed: false }, { uri: "https://other.test", title: "source", position: 9, attributed: true }])
    expect(r.providerMetadata).toEqual({ model: "actual", usage: { total_tokens: 3 } })
    const request = call.captured() as { method: string; url: string; headers: Record<string, string>; body: { body: Uint8Array } }
    expect(request.method).toBe("POST")
    expect(request.url).toBe("http://localhost/v1/chat/completions")
    expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({ model: "pin", messages: [{ role: "user", content: "test prompt" }], stream: false })
    expect(request.headers["authorization"]).toBe("Bearer test-only-key")
  })
  it("keeps absent model, citations, content type, and metadata unknown", async () => {
    const result = await invoke('{"choices":[{"message":{"content":""}}]}', 200, settings, {}).result
    if (result._tag !== "Right") throw new Error("expected success")
    expect(result.right.observedModel).toBeNull()
    expect(result.right.citations).toEqual([])
    // Response(string) supplies text/plain; actual HTTP missing header tested in local HTTP suite.
    expect(result.right.providerMetadata).toBeNull()
  })
  it.each([[401, "ProviderAuth", false], [403, "ProviderAuth", false], [429, "ProviderRateLimited", true], [503, "ProviderUnavailable", true], [400, "ProviderUnsupported", false], [302, "ProviderUnsupported", false]])("maps HTTP %s safely", async (status, tag, retry) => {
    const result = await invoke("sensitive-provider-body", status as number).result
    if (result._tag !== "Left") throw new Error("expected failure")
    expect(result.left._tag).toBe(tag)
    expect(isRetryableProviderError(result.left)).toBe(retry)
    expect(JSON.stringify(result.left)).not.toContain("sensitive-provider-body")
    expect(String(result.left)).not.toContain("test-only-key")
    const evidence = Redacted.value(result.left.evidence!)
    expect(new TextDecoder().decode(evidence.rawBytes)).toBe("sensitive-provider-body")
    expect(evidence.rawDigest).toBe(sha256(evidence.rawBytes))
  })
  it.each([["{", "ProviderMalformed"], ["{}", "ProviderContractMismatch"], ['{"choices":[]}', "ProviderContractMismatch"], ['{"choices":[{"message":{"content":42}}]}', "ProviderContractMismatch"]])("rejects invalid response %s", async (text, tag) => {
    const r = await invoke(text).result
    expect(r._tag === "Left" && r.left._tag).toBe(tag)
  })
  it("fails closed above the byte bound without retaining partial evidence", async () => {
    const r = await invoke(body, 200, { ...settings, responseMaxBytes: 5 }).result
    expect(r._tag === "Left" && r.left._tag).toBe("ProviderMalformed")
    if (r._tag === "Left") expect(r.left.evidence).toBeUndefined()
  })
  it("rejects disabled gateway and mismatched pinned models before network IO", async () => {
    let calls = 0
    const http = Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => { calls++; return Effect.never }))
    for (const cfg of [null, settings]) {
      const r = await Effect.runPromise(Effect.gen(function*() {
        return yield* (yield* NineRouterProvider).observe({ ...input, requestedModel: "wrong" })
      }).pipe(Effect.provide(NineRouterProviderLive.pipe(Layer.provide(http), Layer.provide(Layer.succeed(NineRouterSettings, cfg)))), Effect.either))
      expect(r._tag === "Left" && r.left._tag).toBe("ProviderUnsupported")
    }
    expect(calls).toBe(0)
  })
  it("timeout interrupts the underlying HTTP effect", async () => {
    let cancelled = false
    const http = Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { cancelled = true })))))
    const r = await Effect.runPromise(Effect.gen(function*() { return yield* (yield* NineRouterProvider).observe(input) }).pipe(
      Effect.provide(NineRouterProviderLive.pipe(Layer.provide(http), Layer.provide(Layer.succeed(NineRouterSettings, { ...settings, timeoutMs: 5 })))), Effect.either,
    ))
    expect(r._tag === "Left" && r.left._tag).toBe("ProviderTimeout")
    expect(cancelled).toBe(true)
  })
  it.each([["__wrong__", "$29"], ["__supported__", "does not integrate"], ["__unknown__", "don't have enough"], ["cancel", "not sure"], ["unrelated", "don't have enough"]])("mock fixture %s is synthetic and citation-free", async (prompt, answer) => {
    const r = await Effect.runPromise(Effect.gen(function*() { return yield* (yield* MockProvider).observe({ ...input, provider: "mock", prompt }) }).pipe(Effect.provide(MockProviderLive)))
    expect(r.answerText).toContain(answer)
    expect(r.synthetic).toBe(true)
    expect(r.citations).toEqual([])
    expect(r.rawDigest).toBe(sha256(r.rawBytes))
  })
  it("mock failure is typed and retryable", async () => {
    const r = await Effect.runPromise(Effect.gen(function*() { return yield* (yield* MockProvider).observe({ ...input, provider: "mock", prompt: "__fail__" }) }).pipe(Effect.provide(MockProviderLive), Effect.either))
    expect(r._tag === "Left" && r.left._tag).toBe("ProviderUnavailable")
  })
  it("registry routes supported providers and rejects unconfigured providers", async () => {
    const nine = Layer.succeed(NineRouterProvider, { observe: () => Effect.fail(new ProviderUnsupported({})) })
    const r = await Effect.runPromise(Effect.gen(function*() { return yield* (yield* ProviderRegistry).observe({ ...input, provider: "openai" }) }).pipe(Effect.provide(ProviderRegistryLive.pipe(Layer.provide(MockProviderLive), Layer.provide(nine))), Effect.either))
    expect(r._tag === "Left" && r.left._tag).toBe("ProviderUnsupported")
    expect(Schema.decodeUnknownEither(ProviderRequest)({ ...input, prompt: "" })._tag).toBe("Left")
  })
})
