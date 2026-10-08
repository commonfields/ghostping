// Gemini API with Google Search grounding (generateContent + google_search
// tool). Requested retrieval is not observed retrieval: an answer counts as
// retrieval-backed only when the response carries grounding metadata with
// search queries or grounding sources. Otherwise it is stored as NONE.
// Failures never fall back to another model or provider.
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { GeminiSettings } from "@openrecord/config"
import {
  GeminiProvider, ProviderAuth, ProviderContractMismatch, ProviderMalformed,
  ProviderRateLimited, ProviderTimeout, ProviderUnavailable, ProviderUnsupported, rawEvidence,
} from "./model.js"

export const GEMINI_RETRIEVAL_TOOL = "google_search"

const Part = Schema.Struct({ text: Schema.optional(Schema.String), thought: Schema.optional(Schema.Boolean) })
const GroundingChunk = Schema.Struct({ web: Schema.optional(Schema.Struct({ uri: Schema.optional(Schema.String), title: Schema.optional(Schema.String) })) })
const GroundingSupport = Schema.Struct({ groundingChunkIndices: Schema.optional(Schema.Array(Schema.Number)) })
export const GeminiResponse = Schema.Struct({
  candidates: Schema.Array(Schema.Struct({
    content: Schema.optional(Schema.Struct({ parts: Schema.optional(Schema.Array(Part)), role: Schema.optional(Schema.String) })),
    finishReason: Schema.optional(Schema.String),
    groundingMetadata: Schema.optional(Schema.Struct({
      webSearchQueries: Schema.optional(Schema.Array(Schema.String)),
      groundingChunks: Schema.optional(Schema.Array(GroundingChunk)),
      groundingSupports: Schema.optional(Schema.Array(GroundingSupport)),
      searchEntryPoint: Schema.optional(Schema.Struct({ renderedContent: Schema.optional(Schema.String) })),
    })),
  })).pipe(Schema.minItems(1)),
  modelVersion: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  usageMetadata: Schema.optional(Schema.Unknown),
})

/** Pure mapping from a decoded response; exported for fixture tests. */
export const interpretGemini = (decoded: typeof GeminiResponse.Type) => {
  const candidate = decoded.candidates[0]!
  const answerText = (candidate.content?.parts ?? []).filter(p => p.thought !== true).map(p => p.text ?? "").join("")
  const grounding = candidate.groundingMetadata
  const queries = grounding?.webSearchQueries ?? []
  const chunks = grounding?.groundingChunks ?? []
  const supported = new Set((grounding?.groundingSupports ?? []).flatMap(s => s.groundingChunkIndices ?? []))
  const citations = chunks.flatMap((chunk, i) => {
    const web = chunk.web
    if (!web || (web.uri === undefined && web.title === undefined)) return []
    return [{ uri: web.uri ?? null, title: web.title ?? null, position: i + 1, attributed: supported.has(i) }]
  })
  const retrievalObserved = queries.some(q => q.trim().length > 0) || citations.some(c => {
    if (!c.uri) return false
    try { const u = new URL(c.uri); return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password } catch { return false }
  })
  return {
    answerText,
    citations,
    retrievalMode: retrievalObserved ? ("PROVIDER_GROUNDING" as const) : ("NONE" as const),
    observedModel: decoded.modelVersion ?? null,
    providerMetadata: {
      responseId: decoded.responseId ?? null, modelVersion: decoded.modelVersion ?? null, finishReason: candidate.finishReason ?? null,
      webSearchQueries: queries, groundingChunkCount: chunks.length, usageMetadata: decoded.usageMetadata ?? null,
      searchSuggestionsHtml: grounding?.searchEntryPoint?.renderedContent ?? null,
    },
  }
}

export const GeminiProviderLive = Layer.effect(GeminiProvider, Effect.gen(function*() {
  const cfg = yield* GeminiSettings
  const http = yield* HttpClient.HttpClient
  return { observe: (input) => Effect.gen(function*() {
    // One configured surface: never silently substitute another model, and
    // never run this retrieval adapter for a no-retrieval request.
    if (!cfg || input.requestedModel !== cfg.model || input.retrievalMode === "NONE" || input.retrievalMode === "MANUAL_CAPTURE") {
      return yield* Effect.fail(new ProviderUnsupported({}))
    }
    const requestBody = { contents: [{ role: "user", parts: [{ text: input.prompt }] }], tools: [{ google_search: {} }] }
    const request = yield* HttpClientRequest.post(`${Redacted.value(cfg.baseUrl).replace(/\/$/, "")}/models/${encodeURIComponent(cfg.model)}:generateContent`).pipe(
      HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey)),
      HttpClientRequest.bodyJson(requestBody),
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
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    // Google reports an invalid key as 400 API_KEY_INVALID, not 401.
    if (response.status === 401 || response.status === 403 || (response.status === 400 && text.includes("API_KEY_INVALID"))) return yield* Effect.fail(new ProviderAuth(fields))
    if (response.status === 429) return yield* Effect.fail(new ProviderRateLimited(fields))
    if (response.status >= 500) return yield* Effect.fail(new ProviderUnavailable(fields))
    if (response.status < 200 || response.status >= 300) return yield* Effect.fail(new ProviderUnsupported(fields))
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), catch: () => new ProviderMalformed(fields),
    })
    const decoded = yield* Schema.decodeUnknown(GeminiResponse)(parsed).pipe(Effect.mapError(() => new ProviderContractMismatch(fields)))
    const result = interpretGemini(decoded)
    // A blocked or empty candidate is not an answer to judge.
    if (result.answerText.trim().length === 0) return yield* Effect.fail(new ProviderContractMismatch(fields))
    return {
      ...raw, provider: "gemini", requestedModel: input.requestedModel, observedModel: result.observedModel,
      collectedAt: new Date().toISOString(), answerText: result.answerText, retrievalMode: result.retrievalMode,
      modelVersion: result.observedModel, retrievalTool: GEMINI_RETRIEVAL_TOOL,
      requestParameters: { model: cfg.model, tools: [GEMINI_RETRIEVAL_TOOL], sampling_parameters: "PROVIDER_DEFAULT" },
      citations: result.citations, rawResponse: parsed, providerMetadata: result.providerMetadata, synthetic: false,
    }
  }).pipe(Effect.timeoutFail({ duration: cfg?.timeoutMs ?? 60_000, onTimeout: () => new ProviderTimeout({}) })) }
}))
