import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { NineRouterSettings } from "@openrecord/config"
import {
  NineRouterProvider, ProviderAuth, ProviderContractMismatch, ProviderMalformed,
  ProviderRateLimited, ProviderTimeout, ProviderUnavailable, ProviderUnsupported, rawEvidence,
} from "./model.js"
const ProviderCitation = Schema.Union(Schema.String, Schema.Struct({
  uri: Schema.optional(Schema.NullOr(Schema.String)), title: Schema.optional(Schema.NullOr(Schema.String)),
  position: Schema.optional(Schema.NullOr(Schema.Int)), attributed: Schema.optional(Schema.Boolean),
}))
export const NineRouterResponse = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })).pipe(Schema.minItems(1)),
  model: Schema.optional(Schema.NullOr(Schema.String)), citations: Schema.optional(Schema.Array(ProviderCitation)),
  id: Schema.optional(Schema.Unknown), object: Schema.optional(Schema.Unknown),
  created: Schema.optional(Schema.Unknown), usage: Schema.optional(Schema.Unknown), system_fingerprint: Schema.optional(Schema.Unknown),
})
export const NineRouterProviderLive = Layer.effect(NineRouterProvider, Effect.gen(function*() {
  const cfg = yield* NineRouterSettings
  const http = yield* HttpClient.HttpClient
  return { observe: (input) => Effect.gen(function*() {
    if (!cfg || input.requestedModel === null || !cfg.models.includes(input.requestedModel)) {
      return yield* Effect.fail(new ProviderUnsupported({}))
    }
    const request = yield* HttpClientRequest.post(`${Redacted.value(cfg.baseUrl).replace(/\/$/, "")}/chat/completions`).pipe(
      HttpClientRequest.bearerToken(cfg.apiKey),
      HttpClientRequest.bodyJson({ model: input.requestedModel, messages: [{ role: "user", content: input.prompt }], stream: false }),
      Effect.mapError(() => new ProviderContractMismatch({})),
    )
    const response = yield* http.execute(request).pipe(Effect.mapError(() => new ProviderUnavailable({})))
    // Count before retaining each chunk; never allocate an unbounded body.
    let size = 0
    const chunks = yield* response.stream.pipe(
      Stream.mapError(() => new ProviderUnavailable({})),
      Stream.runFoldEffect([] as Uint8Array[], (parts, chunk) => {
        size += chunk.byteLength
        if (size > cfg.responseMaxBytes) return Effect.fail(new ProviderMalformed({}))
        parts.push(chunk)
        return Effect.succeed(parts)
      }),
    )
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength }
    const raw = rawEvidence(bytes, response.headers["content-type"] ?? null, cfg.responseMaxBytes)
    const fields = { evidence: Redacted.make(raw), status: response.status }
    if (response.status === 401 || response.status === 403) return yield* Effect.fail(new ProviderAuth(fields))
    if (response.status === 429) return yield* Effect.fail(new ProviderRateLimited(fields))
    if (response.status >= 500) return yield* Effect.fail(new ProviderUnavailable(fields))
    if (response.status < 200 || response.status >= 300) return yield* Effect.fail(new ProviderUnsupported(fields))
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), catch: () => new ProviderMalformed(fields),
    })
    const decoded = yield* Schema.decodeUnknown(NineRouterResponse)(parsed).pipe(Effect.mapError(() => new ProviderContractMismatch(fields)))
    const citations = (decoded.citations ?? []).flatMap((c, i) => {
      if (typeof c === "string") return [{ uri: c, title: null, position: i + 1, attributed: false }]
      if (c.uri == null && c.title == null) return []
      return [{ uri: c.uri ?? null, title: c.title ?? null, position: c.position ?? i + 1, attributed: c.attributed ?? false }]
    })
    const providerMetadata = Object.fromEntries(
      ["id", "object", "created", "model", "usage", "system_fingerprint"].flatMap(key => Object.hasOwn(decoded, key) ? [[key, Reflect.get(decoded, key)]] : []),
    )
    return {
      ...raw, provider: "9router", requestedModel: input.requestedModel, observedModel: decoded.model ?? null,
      collectedAt: new Date().toISOString(), answerText: decoded.choices[0]!.message.content,
      retrievalMode: "unknown" as const, citations, rawResponse: parsed,
      providerMetadata: Object.keys(providerMetadata).length ? providerMetadata : null, synthetic: false,
    }
  }).pipe(Effect.timeoutFail({ duration: cfg?.timeoutMs ?? 60_000, onTimeout: () => new ProviderTimeout({}) })) }
}))
