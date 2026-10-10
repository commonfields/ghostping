import { Config, Context, Effect, Layer, Option, Redacted } from "effect"

export const DatabaseUrl = Config.redacted("DATABASE_URL")
export const SessionSecret = Config.redacted("SESSION_SECRET")
export const AppBaseUrl = Config.string("APP_BASE_URL").pipe(Config.withDefault("http://localhost:3000"))
export const Port = Config.integer("PORT").pipe(Config.withDefault(3001))

export const AppConfig = Config.all({ DatabaseUrl, SessionSecret, AppBaseUrl, Port })

// Gateway configuration is validated once at construction. Mock-only workers
// need no external credentials; enabling NineRouter requires all secrets.
export const validProviderEndpoint = (value: string): boolean => {
  try {
    const u = new URL(value)
    return !u.username && !u.password && !u.search && !u.hash &&
      (u.protocol === "https:" || (u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
  } catch { return false }
}
export const ProviderResponseMaxBytes = Config.integer("PROVIDER_RESPONSE_MAX_BYTES").pipe(
  Config.withDefault(2 * 1024 * 1024),
  Config.validate({ message: "response bound must be 1..16777216 bytes", validation: n => n > 0 && n <= 16777216 }),
)

const parseModelList = (value: string): ReadonlyArray<string> => {
  const models = value.split(",").map((model) => model.trim())
  if (models.length === 0 || models.some((model) => model.length === 0)) {
    throw new Error("provider model allowlist must not contain empty entries")
  }
  if (models.some((model) => /[\s,]/u.test(model))) {
    throw new Error("provider model identifiers must not contain whitespace or commas")
  }
  if (new Set(models).size !== models.length) {
    throw new Error("provider model allowlist must not contain duplicates")
  }
  return models
}

export const parseNineRouterModels = (models: string | null, legacyModel: string | null): ReadonlyArray<string> => {
  if (models !== null) return parseModelList(models)
  if (legacyModel === null) throw new Error("NINE_ROUTER_MODELS is required when 9Router is enabled")
  const resolved = parseModelList(legacyModel)
  if (resolved.length !== 1) throw new Error("NINE_ROUTER_MODEL accepts exactly one model")
  return resolved
}

const NineRouterModels = Config.all({
  models: Config.option(Config.string("NINE_ROUTER_MODELS")),
  legacyModel: Config.option(Config.string("NINE_ROUTER_MODEL")),
}).pipe(Config.mapAttempt(({ models, legacyModel }) => parseNineRouterModels(
  Option.getOrNull(models), Option.getOrNull(legacyModel),
)))

export const NineRouterEnabled = Config.boolean("NINE_ROUTER_ENABLED").pipe(Config.withDefault(false))
// Shared non-secret validation for the worker and API catalog. The API does
// not need a key: deployments may keep credentials exclusively on workers.
export const NineRouterConnectionConfig = Config.all({
  baseUrl: Config.string("NINE_ROUTER_BASE_URL").pipe(
    Config.withDefault("http://localhost:20128/v1"),
    Config.validate({ message: "invalid provider endpoint (HTTPS or exact loopback required)", validation: validProviderEndpoint }),
    Config.map(Redacted.make),
  ),
  models: NineRouterModels,
  timeoutMs: Config.integer("NINE_ROUTER_TIMEOUT_MS").pipe(Config.withDefault(60_000), Config.validate({
    message: "timeout must be 1..300000 milliseconds", validation: n => n > 0 && n <= 300_000,
  })),
  responseMaxBytes: ProviderResponseMaxBytes,
})
const NineRouterConfig = Config.all({
  connection: NineRouterConnectionConfig,
  apiKey: Config.redacted("NINE_ROUTER_API_KEY").pipe(Config.validate({
    message: "provider key must be nonempty", validation: key => Redacted.value(key).trim().length > 0,
  })),
}).pipe(Config.map(({ connection, apiKey }) => ({ ...connection, apiKey })))
export type NineRouterSettingsValue = Config.Config.Success<typeof NineRouterConfig>
export class NineRouterSettings extends Context.Tag("NineRouterSettings")<NineRouterSettings, NineRouterSettingsValue | null>() {}
export const NineRouterSettingsLive = Layer.effect(NineRouterSettings, Effect.gen(function*() {
  const enabled = yield* NineRouterEnabled
  return enabled ? yield* NineRouterConfig : null
}))

// Gemini with Google Search grounding: the record's single live surface.
// Absent key = not configured (null); a configured surface needs a key.
export const GeminiModel = Config.string("GEMINI_MODEL").pipe(Config.withDefault("gemini-2.5-flash"), Config.validate({
  message: "model must be a plain model id", validation: m => /^[a-z0-9][a-z0-9.\-]*$/.test(m),
}))
export const RecordSurfaceConfig = Config.all({
  provider: Config.literal("gemini", "mock")("RECORD_PROVIDER").pipe(Config.withDefault("gemini" as const)),
  model: GeminiModel,
})
const GeminiConfig = Config.all({
  baseUrl: Config.string("GEMINI_BASE_URL").pipe(
    Config.withDefault("https://generativelanguage.googleapis.com/v1beta"),
    Config.validate({ message: "invalid provider endpoint (HTTPS or exact loopback required)", validation: validProviderEndpoint }),
    Config.map(Redacted.make),
  ),
  apiKey: Config.redacted("GEMINI_API_KEY").pipe(Config.validate({
    message: "provider key must be nonempty", validation: key => Redacted.value(key).trim().length > 0,
  })),
  model: GeminiModel,
  timeoutMs: Config.integer("GEMINI_TIMEOUT_MS").pipe(Config.withDefault(60_000), Config.validate({
    message: "timeout must be 1..300000 milliseconds", validation: n => n > 0 && n <= 300_000,
  })),
  responseMaxBytes: ProviderResponseMaxBytes,
})
export type GeminiSettingsValue = Config.Config.Success<typeof GeminiConfig>
export class GeminiSettings extends Context.Tag("GeminiSettings")<GeminiSettings, GeminiSettingsValue | null>() {}
export const GeminiSettingsLive = Layer.effect(GeminiSettings, Effect.gen(function*() {
  const key = yield* Config.option(Config.string("GEMINI_API_KEY"))
  return Option.isSome(key) ? yield* GeminiConfig : null
}))
