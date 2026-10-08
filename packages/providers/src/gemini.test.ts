// Gemini grounding adapter against a local HTTP server. Response bodies are
// SYNTHETIC fixtures shaped like the documented generateContent response
// (candidates[].content.parts, groundingMetadata, modelVersion); they are
// not captured from a live call.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { Effect, Layer, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { GeminiSettings, type GeminiSettingsValue } from "@openrecord/config"
import { GeminiProvider, GeminiProviderLive, sha256, type ProviderRequest } from "./index.js"

const grounded = JSON.stringify({
  candidates: [{
    content: { role: "model", parts: [{ text: "Check-in at Acme Hotel " }, { text: "starts at 3:00 PM." }] },
    finishReason: "STOP",
    groundingMetadata: {
      webSearchQueries: ["Acme Hotel check-in time"],
      groundingChunks: [
        { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture-1", title: "acmehotel.example" } },
        { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture-2", title: "travel.example" } },
      ],
      groundingSupports: [{ groundingChunkIndices: [0] }],
    },
  }],
  modelVersion: "gemini-2.5-flash",
  responseId: "fixture-response",
  usageMetadata: { totalTokenCount: 42 },
})
const ungrounded = JSON.stringify({
  candidates: [{ content: { role: "model", parts: [{ text: "I believe check-in is at 2 PM." }] }, finishReason: "STOP" }],
  modelVersion: "gemini-2.5-flash",
})
const emptyGrounding = JSON.stringify({
  candidates: [{ content: { parts: [{ text: "Check-in is at 3 PM." }] }, groundingMetadata: { webSearchQueries: [], groundingChunks: [] } }],
  modelVersion: "gemini-2.5-flash",
})
const withThought = JSON.stringify({
  candidates: [{ content: { parts: [{ text: "internal reasoning", thought: true }, { text: "Breakfast is included." }] },
    groundingMetadata: { webSearchQueries: ["acme breakfast"] } }],
  modelVersion: "gemini-2.5-flash",
})
const blocked = JSON.stringify({ candidates: [{ finishReason: "SAFETY" }], modelVersion: "gemini-2.5-flash" })

let server: Server
let port: number
let requests: Array<{ url: string; key: string | undefined; body: unknown }> = []
const routes: Record<string, { status: number; body: string }> = {
  grounded: { status: 200, body: grounded },
  ungrounded: { status: 200, body: ungrounded },
  emptygrounding: { status: 200, body: emptyGrounding },
  thought: { status: 200, body: withThought },
  blocked: { status: 200, body: blocked },
  badkey: { status: 400, body: JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }) },
  ratelimited: { status: 429, body: "{}" },
  unavailable: { status: 503, body: "{}" },
  nomodel: { status: 404, body: "{}" },
  oversize: { status: 200, body: "x".repeat(5000) },
}
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", chunk => { body += chunk.toString() })
    req.on("end", () => {
      requests.push({ url: req.url ?? "", key: req.headers["x-goog-api-key"] as string | undefined, body: body ? JSON.parse(body) : null })
      const route = routes[(req.url ?? "").split("/")[1] ?? ""]!
      res.writeHead(route.status, { "content-type": "application/json" })
      res.end(route.body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as { port: number }).port
})
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })

const settings = (route: string, over: Partial<GeminiSettingsValue> = {}): GeminiSettingsValue => ({
  baseUrl: Redacted.make(`http://127.0.0.1:${port}/${route}`), apiKey: Redacted.make("fixture-secret-key"), model: "gemini-2.5-flash",
  timeoutMs: 2000, responseMaxBytes: 4096, ...over,
})
const observe = (cfg: GeminiSettingsValue | null, request: Partial<ProviderRequest> = {}) => Effect.runPromise(Effect.gen(function*() {
  return yield* (yield* GeminiProvider).observe({ runId: "gemini-test", provider: "gemini", requestedModel: "gemini-2.5-flash", prompt: "What time is check-in at Acme Hotel?", ...request })
}).pipe(Effect.provide(GeminiProviderLive.pipe(Layer.provide(NodeHttpClient.layer), Layer.provide(Layer.succeed(GeminiSettings, cfg)))), Effect.either))

describe("Gemini grounding adapter (SYNTHETIC response fixtures)", () => {
  it("records grounded answers as PROVIDER_GROUNDING with exact bytes, citations, model and request", async () => {
    requests = []
    const r = await observe(settings("grounded"))
    if (r._tag !== "Right") throw new Error(`expected success, got ${r.left._tag}`)
    const o = r.right
    expect(o.answerText).toBe("Check-in at Acme Hotel starts at 3:00 PM.")
    expect(o.retrievalMode).toBe("PROVIDER_GROUNDING")
    expect(o.retrievalTool).toBe("google_search")
    expect(o.observedModel).toBe("gemini-2.5-flash")
    expect(o.synthetic).toBe(false)
    expect(o.citations).toEqual([
      { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture-1", title: "acmehotel.example", position: 1, attributed: true },
      { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture-2", title: "travel.example", position: 2, attributed: false },
    ])
    expect(o.rawDigest).toBe(sha256(new TextEncoder().encode(grounded)))
    expect(o.requestParameters).toEqual({ model: "gemini-2.5-flash", tools: ["google_search"], sampling_parameters: "PROVIDER_DEFAULT" })
    expect(o.providerMetadata).toMatchObject({ webSearchQueries: ["Acme Hotel check-in time"], responseId: "fixture-response" })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("/grounded/models/gemini-2.5-flash:generateContent")
    expect(requests[0]!.key).toBe("fixture-secret-key")
    expect(requests[0]!.body).toEqual({ contents: [{ role: "user", parts: [{ text: "What time is check-in at Acme Hotel?" }] }], tools: [{ google_search: {} }] })
  })
  it("requested retrieval is not observed retrieval: no grounding metadata is NONE", async () => {
    for (const route of ["ungrounded", "emptygrounding"]) {
      const r = await observe(settings(route))
      if (r._tag !== "Right") throw new Error("expected success")
      expect(r.right.retrievalMode).toBe("NONE")
      expect(r.right.citations).toEqual([])
      // The request still asked for search; the evidence shows it did not happen.
      expect(r.right.requestParameters).toMatchObject({ tools: ["google_search"] })
    }
  })
  it("search queries alone are observed retrieval; thought parts are not answer text", async () => {
    const r = await observe(settings("thought"))
    if (r._tag !== "Right") throw new Error("expected success")
    expect(r.right.answerText).toBe("Breakfast is included.")
    expect(r.right.retrievalMode).toBe("PROVIDER_GROUNDING")
  })
  it("classifies auth, rate limit, outage, unsupported model, blocked answers and oversize bodies", async () => {
    const cases: Array<[string, string]> = [["badkey", "ProviderAuth"], ["ratelimited", "ProviderRateLimited"], ["unavailable", "ProviderUnavailable"],
      ["nomodel", "ProviderUnsupported"], ["blocked", "ProviderContractMismatch"], ["oversize", "ProviderMalformed"]]
    for (const [route, tag] of cases) {
      const r = await observe(settings(route))
      expect(r._tag === "Left" && r.left._tag, route).toBe(tag)
    }
  })
  it("never substitutes another model, never runs without retrieval, and needs configuration", async () => {
    requests = []
    for (const [cfg, request] of [
      [settings("grounded"), { requestedModel: "gemini-2.5-pro" }],
      [settings("grounded"), { requestedModel: null }],
      [settings("grounded"), { retrievalMode: "NONE" as const }],
      [null, {}],
    ] as const) {
      const r = await observe(cfg, request)
      expect(r._tag === "Left" && r.left._tag).toBe("ProviderUnsupported")
    }
    expect(requests).toHaveLength(0)
  })
  it("never renders the API key in errors or configuration", async () => {
    const r = await observe(settings("badkey"))
    expect(r._tag).toBe("Left")
    expect(JSON.stringify(r)).not.toContain("fixture-secret-key")
    expect(String(r._tag === "Left" ? r.left : "")).not.toContain("fixture-secret-key")
    expect(JSON.stringify(settings("grounded"))).not.toContain("fixture-secret-key")
  })
})
