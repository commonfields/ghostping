import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { Effect, Layer, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { NineRouterSettings } from "@openrecord/config"
import { NineRouterProvider, NineRouterProviderLive, sha256 } from "./index.js"
let server: Server
let port: number
let closed = false
let requests = 0
let body: string | null = null
const response = ' {"choices":[{"message":{"content":"answer"}}],"model":"actual"}\n'
beforeAll(async () => {
  server = createServer((req, res) => {
    requests++
    req.on("data", chunk => { body = (body ?? "") + chunk.toString() })
    req.on("end", () => {
      if (req.url?.startsWith("/timeout")) { res.on("close", () => { closed = true }); return }
      if (req.url?.startsWith("/redirect")) { res.writeHead(302, { location: "/success/chat/completions" }); res.end(); return }
      if (req.url?.startsWith("/oversize")) { res.write("x".repeat(100)); res.end("x".repeat(100)); return }
      res.end(response)
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as { port: number }).port
})
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
const observe = (path: string, max = 2048, timeoutMs = 1000) => Effect.runPromise(Effect.gen(function*() {
  return yield* (yield* NineRouterProvider).observe({ runId: "http-test", provider: "9router", requestedModel: "pin", prompt: "fixture" })
}).pipe(Effect.provide(NineRouterProviderLive.pipe(Layer.provide(NodeHttpClient.layer), Layer.provide(Layer.succeed(NineRouterSettings, {
  baseUrl: Redacted.make(`http://127.0.0.1:${port}/${path}`), apiKey: Redacted.make("fixture-key"), models: ["pin"], timeoutMs, responseMaxBytes: max,
})))), Effect.either))
describe("scoped Effect Node HTTP transport", () => {
  it("preserves exact bytes and a genuinely absent content type", async () => {
    const r = await observe("success")
    if (r._tag !== "Right") throw new Error("expected success")
    expect(r.right.rawContentType).toBeNull()
    expect(r.right.rawDigest).toBe(sha256(new TextEncoder().encode(response)))
    expect(JSON.parse(body!)).toMatchObject({ model: "pin", stream: false })
  })
  it("does not follow redirects or forward credentials", async () => {
    const before = requests
    const r = await observe("redirect")
    expect(r._tag === "Left" && r.left._tag).toBe("ProviderUnsupported")
    expect(requests - before).toBe(1)
  })
  it("bounds chunked responses", async () => {
    const r = await observe("oversize", 50)
    expect(r._tag === "Left" && r.left._tag).toBe("ProviderMalformed")
  })
  it("timeout closes the underlying socket", async () => {
    const r = await observe("timeout", 2048, 30)
    expect(r._tag === "Left" && r.left._tag).toBe("ProviderTimeout")
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(closed).toBe(true)
  })
})
