// Surface mappings for the providers the hosted worker currently supports.
// Only directly established metadata is KNOWN. Rust mirrors these mappings in
// `SurfaceIdentityV1::from_worker`.
import {
  knownValue,
  NOT_APPLICABLE,
  schemaId,
  UNKNOWN,
  type KnowledgeJson,
  type KnowledgeString,
  type SurfaceIdentityV1,
} from "./schema.js"

const knownOr = (value: string | null, absent: KnowledgeString): KnowledgeString =>
  value === null ? absent : knownValue(value)

export const surfaceForWorker = (
  provider: string,
  requestedModel: string | null,
  observedModel: string | null,
): SurfaceIdentityV1 => {
  if (provider === "9router") {
    return {
      schema: schemaId.surface,
      schema_version: 1,
      // A router-controlled API. Never a consumer UI and never "ChatGPT".
      kind: "ROUTER_API",
      product: "9Router",
      adapter: "ghostping-9router",
      adapter_version: "1",
      gateway: knownValue("9router"),
      // 9Router does not prove which upstream provider served the request.
      requested_provider: UNKNOWN,
      requested_model: knownOr(requestedModel, UNKNOWN),
      observed_provider: UNKNOWN,
      observed_model: knownOr(observedModel, UNKNOWN),
      account_state: UNKNOWN,
      subscription_tier: UNKNOWN,
      locale: UNKNOWN,
      region: UNKNOWN,
      search_mode: UNKNOWN,
      personalization_state: UNKNOWN,
      metadata_visibility: "PARTIAL",
    }
  }
  if (provider === "mock") {
    return {
      schema: schemaId.surface,
      schema_version: 1,
      kind: "MOCK",
      product: "Ghostping deterministic fixture",
      adapter: "ghostping-mock",
      adapter_version: "1",
      gateway: NOT_APPLICABLE,
      requested_provider: knownValue("mock"),
      requested_model: knownOr(requestedModel, NOT_APPLICABLE),
      observed_provider: knownValue("mock"),
      observed_model: knownOr(observedModel, NOT_APPLICABLE),
      account_state: NOT_APPLICABLE,
      subscription_tier: NOT_APPLICABLE,
      locale: NOT_APPLICABLE,
      region: NOT_APPLICABLE,
      search_mode: NOT_APPLICABLE,
      personalization_state: NOT_APPLICABLE,
      metadata_visibility: "FULL",
    }
  }
  throw new Error(`UnsupportedSurfaceProvider: ${provider}`)
}

/** What the adapter requests. The 9Router adapter sends only
 * `{model, messages, stream:false}`; sampling is left to provider defaults,
 * whose effective values Ghostping does not know. */
export const requestConfigurationForWorker = (provider: string, requestedModel: string | null): KnowledgeJson => {
  if (provider === "9router") {
    return knownValue({ model: requestedModel, sampling_parameters: "PROVIDER_DEFAULT", stream: false })
  }
  if (provider === "mock") return knownValue({ deterministic_fixture: true })
  throw new Error(`UnsupportedSurfaceProvider: ${provider}`)
}
