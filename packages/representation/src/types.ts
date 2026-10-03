// Representation Graph V1 — first-class domain objects.
//
// Laws:
// - Authority is not observation.
// - Observation is not interpretation.
// - Citation is not causality.
// - Absence is not contradiction.
// - Failure is not absence.
// - UNKNOWN is not false.
// - Derived state is recomputed, never independently mutated.
// - One authoritative fact may have many projections; one editable truth.

export const SOURCE_TARGET_CONTROL = ["OWNED", "THIRD_PARTY", "UNKNOWN"] as const
export type SourceControl = (typeof SOURCE_TARGET_CONTROL)[number]

export interface SourceTargetV1 {
  readonly id: string
  readonly business_id: string
  readonly url: string
  readonly control: SourceControl
  readonly enabled: boolean
  readonly created_at: string
}

export const EXTRACTOR_KIND = ["JSON_LD", "CSS_TEXT", "META_CONTENT"] as const
export type ExtractorKind = (typeof EXTRACTOR_KIND)[number]

export const COMPARATOR_KIND = ["EXACT_TEXT", "BOOLEAN", "MONEY"] as const
export type ComparatorKind = (typeof COMPARATOR_KIND)[number]

export interface SourceBindingV1 {
  readonly id: string
  readonly business_id: string
  readonly fact_id: string
  readonly source_target_id: string
  readonly extractor: {
    readonly kind: ExtractorKind
    /** JSON-LD dotted path, CSS selector, or META name/property. */
    readonly selector: string
  }
  readonly comparator: ComparatorKind
  readonly created_at: string
}

export type CollectionState = "FETCHED" | "NOT_MODIFIED" | "FAILED"
export type CollectionFailure =
  | "TIMEOUT"
  | "REDIRECT_LIMIT"
  | "RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "NETWORK_ERROR"
  | "SECURITY_REJECTED"
  | "INVALID_URL"

export interface SourceObservationV1 {
  readonly id: string
  readonly business_id: string
  readonly source_target_id: string
  readonly collector: "NATIVE_HTTP" | "PLAYWRIGHT" | "FIRECRAWL"
  readonly collector_version: string
  readonly requested_url: string
  readonly final_url: string
  readonly started_at: string
  readonly completed_at: string
  readonly http_status: number | null
  readonly content_type: string | null
  readonly etag: string | null
  readonly last_modified: string | null
  readonly body_digest: string | null
  readonly body_bytes: number
  readonly collection_state: CollectionState
  readonly failure: CollectionFailure | null
  readonly raw_evidence_id: string | null
}

export type ExtractionState = "OBSERVED" | "NOT_FOUND" | "AMBIGUOUS" | "UNSUPPORTED" | "FAILED"

export interface ObservedSourceValueV1 {
  readonly id: string
  readonly business_id: string
  readonly source_observation_id: string
  readonly source_binding_id: string
  readonly fact_id: string
  /** Normalized extracted text (money/boolean normalized where applicable). */
  readonly extracted_value: string | null
  readonly extraction_state: ExtractionState
  readonly evidence_locator: {
    readonly selector: string
    readonly source_observation_id: string
    readonly node_identity: string | null
  }
  readonly extractor_version: string
  readonly created_at: string
}

export type RepresentationState = "IN_SYNC" | "DRIFT" | "UNKNOWN"

export interface RepresentationFindingV1 {
  readonly fact_id: string
  readonly source_binding_id: string
  readonly source_observation_id: string
  readonly observed_value_id: string | null
  readonly state: RepresentationState
  readonly reason: string
}

export interface AiCitationEdge {
  readonly observation_id: string
  readonly claim_id: string | null
  readonly citation_uri: string
  readonly source_target_id: string
  /** Always CITED; never CAUSED_BY. */
  readonly edge: "CITED"
}

export interface FactRepresentationGraph {
  readonly fact: { readonly id: string; readonly value_text: string; readonly value_type: string }
  readonly targets: ReadonlyArray<SourceTargetV1>
  readonly bindings: ReadonlyArray<SourceBindingV1>
  readonly observations: ReadonlyArray<SourceObservationV1>
  readonly values: ReadonlyArray<ObservedSourceValueV1>
  readonly findings: ReadonlyArray<RepresentationFindingV1>
  readonly citation_edges: ReadonlyArray<AiCitationEdge>
}
