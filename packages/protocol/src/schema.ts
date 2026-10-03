// Ghostping Evidence Protocol V1 — canonical domain schemas.
//
// These Effect Schemas are the single source of truth. JSON Schemas in
// `schemas/ghostping` are generated from them (`pnpm --filter
// @ghostping/protocol schemas`) and a test fails when they drift.
//
// Design rule: every field is exactly one of evidence, authority,
// interpretation, action, or derived view. Hidden dimensions use explicit
// Knowledge states; UNKNOWN is never encoded as false/null/disabled.
import { Schema } from "effect"

/** Evidence-schema version. Independent of package/application versions. */
export const PROTOCOL_VERSION = 1 as const

export const schemaId = {
  fact: "ghostping/fact-v1",
  surface: "ghostping/surface-v1",
  measurement: "ghostping/measurement-context-v1",
  observation: "ghostping/observation-v1",
  claim: "ghostping/claim-v1",
  judgment: "ghostping/judgment-v1",
  issue: "ghostping/issue-v1",
  intervention: "ghostping/intervention-v1",
  reobservation: "ghostping/reobservation-v1",
  packet: "ghostping/evidence-packet-v1",
} as const

const header = <S extends string>(id: S) => ({
  schema: Schema.Literal(id),
  schema_version: Schema.Literal(PROTOCOL_VERSION),
})

export const Id = Schema.String.pipe(Schema.minLength(1))
/** UTC RFC 3339 with `Z`; seconds or exactly three fractional digits. */
export const Timestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
)
/** Lowercase hex SHA-256. */
export const Digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))

// ---------------------------------------------------------------------------
// Knowledge states
// ---------------------------------------------------------------------------
const Unknown = Schema.Struct({ state: Schema.Literal("UNKNOWN") })
const NotApplicable = Schema.Struct({ state: Schema.Literal("NOT_APPLICABLE") })
const known = <A, I, R>(value: Schema.Schema<A, I, R>) =>
  Schema.Struct({ state: Schema.Literal("KNOWN"), value })

export const KnowledgeString = Schema.Union(known(Schema.String), Unknown, NotApplicable)
export type KnowledgeString = typeof KnowledgeString.Type
export const KnowledgeJson = Schema.Union(known(Schema.Unknown), Unknown, NotApplicable)
export type KnowledgeJson = typeof KnowledgeJson.Type
export const KnowledgeDigest = Schema.Union(known(Digest), Unknown, NotApplicable)
export type KnowledgeDigest = typeof KnowledgeDigest.Type

export const knownValue = <T>(value: T) => ({ state: "KNOWN" as const, value })
export const UNKNOWN = { state: "UNKNOWN" as const }
export const NOT_APPLICABLE = { state: "NOT_APPLICABLE" as const }

// ---------------------------------------------------------------------------
// Surface identity + measurement context
// ---------------------------------------------------------------------------
export const SurfaceKind = Schema.Literal(
  "CONSUMER_UI",
  "DIRECT_API",
  "ROUTER_API",
  "SEARCH_GROUNDED_API",
  "LOCAL_MODEL",
  "MOCK",
)
export type SurfaceKind = typeof SurfaceKind.Type

export const MetadataVisibility = Schema.Literal("FULL", "PARTIAL", "NONE", "UNKNOWN")

export const SurfaceIdentityV1 = Schema.Struct({
  ...header(schemaId.surface),
  kind: SurfaceKind,
  product: Schema.String,
  adapter: Schema.String,
  adapter_version: Schema.String,
  gateway: KnowledgeString,
  requested_provider: KnowledgeString,
  requested_model: KnowledgeString,
  observed_provider: KnowledgeString,
  observed_model: KnowledgeString,
  account_state: KnowledgeString,
  subscription_tier: KnowledgeString,
  locale: KnowledgeString,
  region: KnowledgeString,
  search_mode: KnowledgeString,
  personalization_state: KnowledgeString,
  metadata_visibility: MetadataVisibility,
})
export type SurfaceIdentityV1 = typeof SurfaceIdentityV1.Type

export const MeasurementContextV1 = Schema.Struct({
  ...header(schemaId.measurement),
  /** Exact prompt as sent. Never trimmed or whitespace-normalized. */
  question: Schema.String,
  question_id: Id,
  question_version: KnowledgeString,
  business_id: Id,
  surface: SurfaceIdentityV1,
  observed_at: Timestamp,
  /** What Ghostping requested (sampling, streaming, …). Not provider-effective state. */
  measurement_configuration: KnowledgeJson,
  sample_number: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  repeat_id: KnowledgeString,
})
export type MeasurementContextV1 = typeof MeasurementContextV1.Type

// ---------------------------------------------------------------------------
// Authority, evidence, interpretation
// ---------------------------------------------------------------------------
export const BusinessIdentity = Schema.Struct({ id: Id, name: Schema.String })

export const CitationV1 = Schema.Struct({
  uri: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  position: Schema.NullOr(Schema.Number),
  attributed: Schema.Boolean,
})

export const RawEvidenceRefV1 = Schema.Struct({
  id: Id,
  digest_sha256: Digest,
  content_type: Schema.String,
  received_at: Timestamp,
  reference: Schema.String,
  /** Present only when export explicitly requests embedded evidence. */
  embedded_bytes_base64: Schema.optional(Schema.String),
})

export const FactV1 = Schema.Struct({
  ...header(schemaId.fact),
  id: Id,
  business_id: Id,
  subject: Schema.String,
  predicate: Schema.String,
  value_text: Schema.String,
  value_type: Schema.String,
  status: Schema.Literal("ACTIVE", "SUPERSEDED", "RETIRED"),
  version: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  supersedes_id: Schema.NullOr(Id),
  valid_from: Timestamp,
  valid_until: Schema.NullOr(Timestamp),
  source_kind: Schema.String,
  created_at: Timestamp,
})
export type FactV1 = typeof FactV1.Type

export const ObservationV1 = Schema.Struct({
  ...header(schemaId.observation),
  id: Id,
  business_id: Id,
  measurement: MeasurementContextV1,
  raw_evidence: RawEvidenceRefV1,
  /** Derived from raw evidence; raw evidence is canonical. */
  normalized_answer_text: Schema.String,
  /** Only citations the provider actually returned. */
  citations: Schema.Array(CitationV1),
  provider_metadata: KnowledgeJson,
  synthetic: Schema.Boolean,
  created_at: Timestamp,
})
export type ObservationV1 = typeof ObservationV1.Type

export const ClaimV1 = Schema.Struct({
  ...header(schemaId.claim),
  id: Id,
  business_id: Id,
  observation_id: Id,
  text: Schema.String,
  origin: Schema.Literal("MANUAL_TRANSCRIPTION", "MANUAL_EXACT_SPAN"),
  created_at: Timestamp,
})
export type ClaimV1 = typeof ClaimV1.Type

export const Verdict = Schema.Literal("SUPPORTED", "CONTRADICTED", "PARTIAL", "INSUFFICIENT_EVIDENCE")
export type Verdict = typeof Verdict.Type

export const JudgmentV1 = Schema.Struct({
  ...header(schemaId.judgment),
  id: Id,
  business_id: Id,
  claim_id: Id,
  verdict: Verdict,
  notes: Schema.NullOr(Schema.String),
  /** Authority versions the reviewer compared against. */
  fact_ids: Schema.Array(Id),
  supersedes_id: Schema.NullOr(Id),
  created_at: Timestamp,
})
export type JudgmentV1 = typeof JudgmentV1.Type

export const IssueState = Schema.Literal("WRONG", "PARTIAL", "NEEDS_REVIEW", "UNKNOWN", "RESOLVED")
export type IssueState = typeof IssueState.Type

/** Derived view over a claim's judgment chain; never independently edited. */
export const IssueV1 = Schema.Struct({
  ...header(schemaId.issue),
  id: Id,
  business_id: Id,
  observation_id: Id,
  claim_id: Id,
  type: KnowledgeString,
  state: IssueState,
  derived_from_judgment_id: Schema.NullOr(Id),
  created_at: Timestamp,
})
export type IssueV1 = typeof IssueV1.Type

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------
export const InterventionType = Schema.Literal(
  "SOURCE_UPDATED",
  "SOURCE_PUBLISHED",
  "THIRD_PARTY_CORRECTION_REQUESTED",
  "KNOWLEDGE_BASE_UPDATED",
  "STRUCTURED_DATA_UPDATED",
  "OTHER",
)
export type InterventionType = typeof InterventionType.Type
export const InterventionActor = Schema.Literal("HUMAN", "AGENT", "SYSTEM", "UNKNOWN")
export type InterventionActor = typeof InterventionActor.Type

export const InterventionV1 = Schema.Struct({
  ...header(schemaId.intervention),
  id: Id,
  business_id: Id,
  issue_ids: Schema.Array(Id),
  type: InterventionType,
  target: Schema.String,
  performed_at: Timestamp,
  actor: InterventionActor,
  actor_id: KnowledgeString,
  notes: Schema.NullOr(Schema.String),
  evidence_before_digest: KnowledgeDigest,
  evidence_after_digest: KnowledgeDigest,
  supersedes_id: Schema.NullOr(Id),
  correction_reason: Schema.NullOr(Schema.String),
  created_at: Timestamp,
})
export type InterventionV1 = typeof InterventionV1.Type

// ---------------------------------------------------------------------------
// Derived comparison views
// ---------------------------------------------------------------------------
export const MatchClassification = Schema.Literal("EXACT_MATCH", "COMPARABLE", "NOT_COMPARABLE", "INDETERMINATE")
export type MatchClassification = typeof MatchClassification.Type
export const ObservedChange = Schema.Literal("NO_CHANGE", "CHANGED", "INDETERMINATE")
export type ObservedChange = typeof ObservedChange.Type
export const ObservedOutcome = Schema.Literal(
  "OBSERVED_CORRECTION",
  "OBSERVED_REGRESSION",
  "OBSERVED_DIFFERENCE",
  "NO_OBSERVED_CHANGE",
  "INDETERMINATE",
  "NOT_OBSERVED",
)
export type ObservedOutcome = typeof ObservedOutcome.Type
/** V1 has no causal experiment protocol; attribution is always UNKNOWN. */
export const CausalAttribution = Schema.Literal("UNKNOWN")

export const MeasurementSignatureV1 = Schema.Struct({
  business_id: Id,
  question_id: Id,
  question_version: KnowledgeString,
  exact_question_digest: Digest,
  surface_kind: SurfaceKind,
  product: Schema.String,
  adapter: Schema.String,
  adapter_version: Schema.String,
  gateway: KnowledgeString,
  requested_provider: KnowledgeString,
  requested_model: KnowledgeString,
  observed_provider: KnowledgeString,
  observed_model: KnowledgeString,
  account_state: KnowledgeString,
  subscription_tier: KnowledgeString,
  search_mode: KnowledgeString,
  locale: KnowledgeString,
  region: KnowledgeString,
  personalization_state: KnowledgeString,
  generation_configuration: KnowledgeJson,
})
export type MeasurementSignatureV1 = typeof MeasurementSignatureV1.Type

export const ReobservationV1 = Schema.Struct({
  ...header(schemaId.reobservation),
  id: Id,
  business_id: Id,
  original_observation_id: Id,
  issue_id: Id,
  intervention_id: Schema.NullOr(Id),
  observation_id: Id,
  before_signature: MeasurementSignatureV1,
  after_signature: MeasurementSignatureV1,
  match_classification: MatchClassification,
  before_judgment_id: Schema.NullOr(Id),
  after_claim_id: Schema.NullOr(Id),
  after_judgment_id: Schema.NullOr(Id),
  before_verdict: Schema.NullOr(Verdict),
  after_verdict: Schema.NullOr(Verdict),
  observed_change: ObservedChange,
  outcome: ObservedOutcome,
  causal_attribution: CausalAttribution,
  created_at: Timestamp,
})
export type ReobservationV1 = typeof ReobservationV1.Type

/** One thing Ghostping does not know, addressed by object id and field. */
export const ExplicitUnknownV1 = Schema.Struct({ subject_id: Id, field: Schema.String })
export type ExplicitUnknownV1 = typeof ExplicitUnknownV1.Type

// ---------------------------------------------------------------------------
// Evidence packet
// ---------------------------------------------------------------------------
export const EvidencePacketV1 = Schema.Struct({
  ...header(schemaId.packet),
  id: Id,
  business: BusinessIdentity,
  issue: IssueV1,
  /** Every authority version referenced by any judgment (historical included). */
  facts: Schema.Array(FactV1),
  original_observation: ObservationV1,
  claims: Schema.Array(ClaimV1),
  /** Full judgment history for `claims`, oldest first. */
  judgments: Schema.Array(JudgmentV1),
  interventions: Schema.Array(InterventionV1),
  reobservations: Schema.Array(ReobservationV1),
  reobservation_observations: Schema.Array(ObservationV1),
  reobservation_claims: Schema.Array(ClaimV1),
  reobservation_judgments: Schema.Array(JudgmentV1),
  /** Latest re-observation outcome, or NOT_OBSERVED when none exists. */
  observed_outcome: ObservedOutcome,
  causal_attribution: CausalAttribution,
  explicit_unknowns: Schema.Array(ExplicitUnknownV1),
  synthetic: Schema.Boolean,
  generated_at: Timestamp,
  /** Reserved for a future signed version; V1 writers emit []. */
  signatures: Schema.Tuple(),
  packet_digest: Digest,
})
export type EvidencePacketV1 = typeof EvidencePacketV1.Type
export type UnsealedEvidencePacketV1 = Omit<EvidencePacketV1, "packet_digest">

export const protocolSchemas = {
  fact: FactV1,
  surface: SurfaceIdentityV1,
  measurement: MeasurementContextV1,
  observation: ObservationV1,
  claim: ClaimV1,
  judgment: JudgmentV1,
  issue: IssueV1,
  intervention: InterventionV1,
  reobservation: ReobservationV1,
  packet: EvidencePacketV1,
} as const
