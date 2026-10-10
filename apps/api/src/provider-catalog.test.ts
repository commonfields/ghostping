import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Schema } from "effect"
import { ProviderCatalogResponse } from "@openrecord/contracts"
import { loadProviderCatalog } from "./provider-catalog.js"

const load = (vars: Record<string, string> = {}, recordFixtures = false) => Effect.runPromise(
  loadProviderCatalog(false, recordFixtures).pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(vars))))),
)

describe("provider declarations are not live availability", () => {
  it("exposes the record's Gemini API adapter without requiring worker credentials", async () => {
    const catalog = await load()
    expect(Schema.decodeUnknownEither(ProviderCatalogResponse)(catalog)._tag).toBe("Right")
    expect(catalog.providers.find(p => p.id === "gemini")).toMatchObject({
      enabled: true, configurationStatus: "DECLARED", workerAvailability: "UNKNOWN", workflows: ["record"], models: ["gemini-2.5-flash"],
      capabilities: { surfaceKind: "SEARCH_GROUNDED_API", provenance: { answerSpanAttribution: "UNSUPPORTED" } },
    })
    expect(catalog.providers.find(p => p.id === "9router")).toMatchObject({ enabled: false, configurationStatus: "DISABLED", models: [] })
  })

  it("uses the worker allowlist precedence and preserves unknown worker availability", async () => {
    const catalog = await load({ NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODELS: " provider/model-a ,provider/model-b", NINE_ROUTER_MODEL: "ignored" })
    expect(catalog.providers.find(p => p.id === "9router")).toMatchObject({
      enabled: true, configurationStatus: "DECLARED", workerAvailability: "UNKNOWN", models: ["provider/model-a", "provider/model-b"], workflows: ["checks", "assay"],
      capabilities: { provenance: { retrievalExecutionReporting: "UNKNOWN" } },
    })
    expect((await load({ NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODEL: "provider/legacy" })).providers.find(p => p.id === "9router")?.models).toEqual(["provider/legacy"])
  })

  it.each(["", "provider/a,", "provider/a,provider/a", "provider/model with spaces"])("fails closed for malformed allowlist %s", async models => {
    const catalog = await load({ NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODELS: models })
    expect(catalog.providers.find(p => p.id === "9router")).toMatchObject({ enabled: false, configurationStatus: "INVALID", models: [] })
  })

  it("does not disclose keys, private endpoints, or malformed configuration values", async () => {
    const catalog = await load({ NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODELS: "provider/a", NINE_ROUTER_API_KEY: "TEST-private-key",
      NINE_ROUTER_BASE_URL: "https://private-router.example.test/v1", GEMINI_API_KEY: "TEST-google-key" })
    const encoded = JSON.stringify(catalog)
    for (const privateValue of ["TEST-private-key", "TEST-google-key", "private-router.example.test"]) expect(encoded).not.toContain(privateValue)
    const bad = await load({ NINE_ROUTER_ENABLED: "true", NINE_ROUTER_MODELS: "provider/a", NINE_ROUTER_BASE_URL: "https://TEST-secret@private.example.test" })
    expect(bad.providers.find(p => p.id === "9router")?.configurationStatus).toBe("INVALID")
    expect(JSON.stringify(bad)).not.toContain("TEST-secret")
  })

  it("uses shared Gemini model validation and gates the fixture record workflow", async () => {
    expect((await load({ GEMINI_MODEL: "bad/model" })).providers.find(p => p.id === "gemini")).toMatchObject({ enabled: false, configurationStatus: "INVALID", models: [] })
    expect((await load({ RECORD_PROVIDER: "mock" })).providers.find(p => p.id === "mock")?.workflows).not.toContain("record")
    expect((await load({ RECORD_PROVIDER: "mock" }, true)).providers.find(p => p.id === "mock")?.workflows).toContain("record")
    expect((await load({ RECORD_PROVIDER: "mock" }, true)).providers.find(p => p.id === "gemini")?.enabled).toBe(false)
  })
})
