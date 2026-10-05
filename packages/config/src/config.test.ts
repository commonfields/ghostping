import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Redacted } from "effect"
import { NineRouterSettings, NineRouterSettingsLive, validProviderEndpoint } from "./index.js"
const load = (pairs: Record<string, string>) => Effect.gen(function*() {
  return yield* NineRouterSettings
}).pipe(Effect.provide(NineRouterSettingsLive), Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(pairs)))))
describe("provider configuration", () => {
  it("allows mock-only startup without credentials", async () => {
    expect(await Effect.runPromise(load({}))).toBeNull()
  })
  it("requires a key and nonempty model allowlist when enabled", async () => {
    for (const vars of [{ NINE_ROUTER_ENABLED: "true" }, { NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODELS: "provider/model-a" }]) {
      expect((await Effect.runPromise(Effect.either(load(vars))))._tag).toBe("Left")
    }
  })
  it("resolves one canonical trimmed allowlist from one or multiple models", async () => {
    const one = await Effect.runPromise(load({ NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODELS: " provider/model-a ", NINE_ROUTER_API_KEY: "test-key" }))
    const many = await Effect.runPromise(load({ NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODELS: "provider/model-a, provider/model-b", NINE_ROUTER_API_KEY: "test-key" }))
    expect(one?.models).toEqual(["provider/model-a"])
    expect(many?.models).toEqual(["provider/model-a", "provider/model-b"])
  })
  it("supports the temporary legacy single-model variable", async () => {
    const cfg = await Effect.runPromise(load({ NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODEL: "provider/model-a", NINE_ROUTER_API_KEY: "test-key" }))
    expect(cfg?.models).toEqual(["provider/model-a"])
  })
  it("rejects empty entries, empty lists, duplicates, and multi-model legacy values", async () => {
    for (const vars of [
      { NINE_ROUTER_MODELS: "" },
      { NINE_ROUTER_MODELS: "provider/model-a," },
      { NINE_ROUTER_MODELS: "provider/model-a, provider/model-a" },
      { NINE_ROUTER_MODEL: "provider/model-a,provider/model-b" },
    ]) {
      const result = await Effect.runPromise(Effect.either(load({ NINE_ROUTER_ENABLED: "true", NINE_ROUTER_API_KEY: "test-key", ...vars })))
      expect(result._tag).toBe("Left")
    }
  })
  it("validates endpoint hosts and URL components", () => {
    for (const url of ["https://example.test/v1", "http://localhost:20128/v1", "http://127.0.0.1/v1", "http://[::1]/v1"]) expect(validProviderEndpoint(url)).toBe(true)
    for (const url of ["http://localhost.evil.test/v1", "http://127.evil.test", "http://192.168.0.1", "https://user:pass@example.test", "https://example.test?key=a", "https://example.test/#a", "file:///etc/passwd", "invalid"]) expect(validProviderEndpoint(url)).toBe(false)
  })
  it("redacts credentials and endpoint in config rendering", async () => {
    const cfg = await Effect.runPromise(load({ NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODELS: "provider/model-a", NINE_ROUTER_API_KEY: "test-secret-only" }))
    expect(cfg).not.toBeNull()
    expect(Redacted.value(cfg!.apiKey)).toBe("test-secret-only")
    expect(JSON.stringify(cfg)).not.toContain("test-secret-only")
    expect(JSON.stringify(cfg)).not.toContain("20128")
  })
  it("rejects empty keys, invalid endpoints, and invalid bounds", async () => {
    const valid = { NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODELS: "provider/model-a", NINE_ROUTER_API_KEY: "test-key" }
    for (const delta of [{ NINE_ROUTER_API_KEY: "" }, { NINE_ROUTER_BASE_URL: "http://localhost.evil.test" }, { PROVIDER_RESPONSE_MAX_BYTES: "0" }, { NINE_ROUTER_TIMEOUT_MS: "-1" }]) {
      expect((await Effect.runPromise(Effect.either(load({ ...valid, ...delta }))))._tag).toBe("Left")
    }
  })
})
