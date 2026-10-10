import { Schema } from "effect"

export const HOSTED_PROVIDER_IDS = ["mock", "9router", "gemini"] as const
export const HostedProviderId = Schema.Literal(...HOSTED_PROVIDER_IDS)
export const CapabilitySupport = Schema.Literal("SUPPORTED", "UNSUPPORTED", "UNKNOWN")
export const RetrievalRequestMode = Schema.Literal("NONE", "WEB_SEARCH", "PROVIDER_GROUNDING", "MANUAL_CAPTURE")

/** Describes the implemented adapter, not upstream model features or a
 * guarantee that a response will contain grounding, citations, or identity. */
export const AnswerSurfaceCapabilitiesV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  surfaceKind: Schema.Literal("MOCK", "ROUTER_API", "SEARCH_GROUNDED_API"),
  synthetic: Schema.Boolean,
  acceptedRetrievalModes: Schema.Array(RetrievalRequestMode),
  provenance: Schema.Struct({
    retrievalExecutionReporting: CapabilitySupport,
    sourceUrlReporting: CapabilitySupport,
    answerSpanAttribution: CapabilitySupport,
    sourceContentCapture: CapabilitySupport,
  }),
  systemPrompt: CapabilitySupport,
  seed: CapabilitySupport,
  structuredOutput: CapabilitySupport,
  multiTurn: CapabilitySupport,
  webSearchTooling: CapabilitySupport,
  bulkBatching: CapabilitySupport,
  logprobs: CapabilitySupport,
  observedModelReporting: CapabilitySupport,
  usageReporting: CapabilitySupport,
  repeatedInvocation: CapabilitySupport,
  determinism: Schema.Literal("FIXTURE_ONLY", "UNKNOWN"),
})
export type AnswerSurfaceCapabilitiesV1 = typeof AnswerSurfaceCapabilitiesV1.Type

const unsupportedControls = {
  systemPrompt: "UNSUPPORTED", seed: "UNSUPPORTED", structuredOutput: "UNSUPPORTED",
  multiTurn: "UNSUPPORTED", bulkBatching: "UNSUPPORTED", logprobs: "UNSUPPORTED",
  repeatedInvocation: "SUPPORTED",
} as const

/** These declarations deliberately cover only capabilities the hosted
 * adapters expose today. Fixture request modes never establish retrieval. */
export const HOSTED_PROVIDER_CAPABILITIES: Readonly<Record<typeof HostedProviderId.Type, AnswerSurfaceCapabilitiesV1>> = {
  mock: {
    ...unsupportedControls, schemaVersion: 1, surfaceKind: "MOCK", synthetic: true,
    acceptedRetrievalModes: ["NONE", "WEB_SEARCH", "PROVIDER_GROUNDING", "MANUAL_CAPTURE"],
    provenance: { retrievalExecutionReporting: "UNSUPPORTED", sourceUrlReporting: "SUPPORTED", answerSpanAttribution: "UNSUPPORTED", sourceContentCapture: "UNSUPPORTED" },
    webSearchTooling: "UNSUPPORTED", observedModelReporting: "SUPPORTED", usageReporting: "UNSUPPORTED", determinism: "FIXTURE_ONLY",
  },
  "9router": {
    ...unsupportedControls, schemaVersion: 1, surfaceKind: "ROUTER_API", synthetic: false,
    acceptedRetrievalModes: ["NONE"],
    provenance: { retrievalExecutionReporting: "UNKNOWN", sourceUrlReporting: "SUPPORTED", answerSpanAttribution: "UNSUPPORTED", sourceContentCapture: "UNSUPPORTED" },
    webSearchTooling: "UNSUPPORTED", observedModelReporting: "SUPPORTED", usageReporting: "SUPPORTED", determinism: "UNKNOWN",
  },
  gemini: {
    ...unsupportedControls, schemaVersion: 1, surfaceKind: "SEARCH_GROUNDED_API", synthetic: false,
    acceptedRetrievalModes: ["WEB_SEARCH", "PROVIDER_GROUNDING"],
    provenance: { retrievalExecutionReporting: "SUPPORTED", sourceUrlReporting: "SUPPORTED", answerSpanAttribution: "UNSUPPORTED", sourceContentCapture: "UNSUPPORTED" },
    webSearchTooling: "SUPPORTED", observedModelReporting: "SUPPORTED", usageReporting: "SUPPORTED", determinism: "UNKNOWN",
  },
}

export const ProviderInfo = Schema.Struct({
  id: HostedProviderId,
  enabled: Schema.Boolean,
  models: Schema.Array(Schema.String),
  workflows: Schema.Array(Schema.Literal("checks", "assay", "record")),
  configurationStatus: Schema.Literal("DECLARED", "DISABLED", "INVALID"),
  // The API and worker may have different environments. This endpoint
  // cannot prove worker credentials, connectivity, or upstream availability.
  workerAvailability: Schema.Literal("UNKNOWN"),
  capabilities: AnswerSurfaceCapabilitiesV1,
})
export type ProviderInfo = typeof ProviderInfo.Type
export const ProviderCatalogResponse = Schema.Struct({
  providers: Schema.Array(ProviderInfo),
  assaySyntheticEnabled: Schema.Boolean,
})
export type ProviderCatalogResponse = typeof ProviderCatalogResponse.Type

/** Counts completed observations. No brand-mention detection is implied. */
export const ProviderDailyAnswer = Schema.Struct({
  date: Schema.String,
  provider: Schema.String,
  answers: Schema.Int.pipe(Schema.nonNegative()),
})
export type ProviderDailyAnswer = typeof ProviderDailyAnswer.Type
