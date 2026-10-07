import { Context, Data, Effect, Redacted, Schema } from "effect"
import { createHash } from "node:crypto"
export const ProviderRequest = Schema.Struct({
  runId: Schema.String.pipe(Schema.minLength(1)), provider: Schema.String.pipe(Schema.minLength(1)),
  retrievalMode: Schema.optional(Schema.Literal("NONE", "WEB_SEARCH", "PROVIDER_GROUNDING", "MANUAL_CAPTURE")),
  sampleNumber: Schema.optional(Schema.Int),
  requestedModel: Schema.NullOr(Schema.String), prompt: Schema.String.pipe(Schema.minLength(1)),
})
export type ProviderRequest = typeof ProviderRequest.Type
export const Citation = Schema.Struct({
  uri: Schema.NullOr(Schema.String), title: Schema.NullOr(Schema.String),
  position: Schema.NullOr(Schema.Int), attributed: Schema.Boolean,
})
export interface RawProviderEvidence {
  readonly responseMaxBytes: number
  readonly rawBytes: Uint8Array
  readonly rawDigest: string
  readonly rawContentType: string | null
}
export interface ProviderObservation extends RawProviderEvidence {
  readonly provider: string
  readonly requestedModel: string | null
  readonly observedModel: string | null
  readonly collectedAt: string
  readonly answerText: string
  readonly retrievalMode: "unknown" | "grounded" | "parametric" | "NONE" | "WEB_SEARCH" | "PROVIDER_GROUNDING" | "MANUAL_CAPTURE"
  readonly modelVersion?: string | null
  readonly retrievalTool?: string | null
  readonly requestParameters?: unknown
  readonly citations: ReadonlyArray<typeof Citation.Type>
  readonly rawResponse: unknown
  readonly providerMetadata: unknown
  readonly synthetic: boolean
}
// Error rendering redacts raw evidence. Only persistence unwraps it.
interface FailureFields {
  readonly evidence?: Redacted.Redacted<RawProviderEvidence>
  readonly status?: number
}
export class ProviderAuth extends Data.TaggedError("ProviderAuth")<FailureFields> {}
export class ProviderRateLimited extends Data.TaggedError("ProviderRateLimited")<FailureFields> {}
export class ProviderTimeout extends Data.TaggedError("ProviderTimeout")<FailureFields> {}
export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<FailureFields> {}
export class ProviderMalformed extends Data.TaggedError("ProviderMalformed")<FailureFields> {}
export class ProviderUnsupported extends Data.TaggedError("ProviderUnsupported")<FailureFields> {}
export class ProviderContractMismatch extends Data.TaggedError("ProviderContractMismatch")<FailureFields> {}
export type ProviderError = ProviderAuth | ProviderRateLimited | ProviderTimeout | ProviderUnavailable |
  ProviderMalformed | ProviderUnsupported | ProviderContractMismatch
export const isRetryableProviderError = (e: ProviderError): boolean =>
  e._tag === "ProviderRateLimited" || e._tag === "ProviderTimeout" || e._tag === "ProviderUnavailable"
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
export const rawEvidence = (rawBytes: Uint8Array, rawContentType: string | null, responseMaxBytes = 2 * 1024 * 1024): RawProviderEvidence =>
  ({ rawBytes, rawContentType, responseMaxBytes, rawDigest: sha256(rawBytes) })
export interface ProviderAdapter {
  readonly observe: (request: ProviderRequest) => Effect.Effect<ProviderObservation, ProviderError>
}
export class MockProvider extends Context.Tag("MockProvider")<MockProvider, ProviderAdapter>() {}
export class NineRouterProvider extends Context.Tag("NineRouterProvider")<NineRouterProvider, ProviderAdapter>() {}
export class ProviderRegistry extends Context.Tag("ProviderRegistry")<ProviderRegistry, ProviderAdapter>() {}

export const isProviderError = (e: { readonly _tag: string }): e is ProviderError =>
  ["ProviderAuth", "ProviderRateLimited", "ProviderTimeout", "ProviderUnavailable", "ProviderMalformed", "ProviderUnsupported", "ProviderContractMismatch"].includes(e._tag)
