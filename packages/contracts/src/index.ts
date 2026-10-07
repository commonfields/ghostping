// Single typed contract shared by apps/api and apps/web.
// Derives request/response shapes from Effect Schema (domain package).
import { Schema } from "effect"

// REST route table (single source of truth for client + server).
export const Routes = {
  signUp: { method: "POST", path: "/api/auth/signup" },
  signIn: { method: "POST", path: "/api/auth/signin" },
  signOut: { method: "POST", path: "/api/auth/signout" },
  me: { method: "GET", path: "/api/auth/me" },
  listBusinesses: { method: "GET", path: "/api/businesses" },
  createBusiness: { method: "POST", path: "/api/businesses" },
  listFacts: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/facts` }),
  createFact: (businessId: string) => ({ method: "POST", path: `/api/businesses/${businessId}/facts` }),
  supersedeFact: (businessId: string, factId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/facts/${factId}/supersede`,
  }),
  retireFact: (businessId: string, factId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/facts/${factId}/retire`,
  }),
  listQuestions: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/questions` }),
  createQuestion: (businessId: string) => ({ method: "POST", path: `/api/businesses/${businessId}/questions` }),
  listCheckRuns: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/check-runs` }),
  runCheck: (businessId: string) => ({ method: "POST", path: `/api/businesses/${businessId}/check-runs` }),
  getObservation: (observationId: string) => ({ method: "GET", path: `/api/observations/${observationId}` }),
  createClaim: { method: "POST", path: "/api/claims" },
  createJudgment: { method: "POST", path: "/api/judgments" },
  listIssues: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/issues` }),
  getIssue: (businessId: string, claimId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/issues/${claimId}` }),
  listInterventions: (businessId: string, claimId: string) => ({
    method: "GET",
    path: `/api/businesses/${businessId}/issues/${claimId}/interventions`,
  }),
  createIntervention: (businessId: string, claimId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/issues/${claimId}/interventions`,
  }),
  listReobservations: (businessId: string, claimId: string) => ({
    method: "GET",
    path: `/api/businesses/${businessId}/issues/${claimId}/reobservations`,
  }),
  requestReobservation: (businessId: string, claimId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/issues/${claimId}/reobservations`,
  }),
  overview: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/overview` }),
  analytics: (businessId: string, days: number) => ({ method: "GET", path: `/api/businesses/${businessId}/analytics?days=${days}` }),
  factHistory: (businessId: string, factId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/facts/${factId}/history` }),
  listRepresentations: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/representations` }),
  getRepresentation: (businessId: string, bindingId: string) => ({
    method: "GET",
    path: `/api/businesses/${businessId}/representations/${bindingId}`,
  }),
  createSourceTarget: (businessId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/representations/targets`,
  }),
  createSourceBinding: (businessId: string, targetId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/representations/targets/${targetId}/bindings`,
  }),
  checkRepresentation: (businessId: string, bindingId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/representations/${bindingId}/check`,
  }),
  getIssueLoop: (businessId: string, claimId: string) => ({
    method: "GET",
    path: `/api/businesses/${businessId}/issues/${claimId}/loop`,
  }),
  listDiscoveryScopes: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/discovery/scopes` }),
  createDiscoveryScope: (businessId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/discovery/scopes`,
  }),
  listDiscoveryRuns: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/discovery/runs` }),
  createDiscoveryRun: (businessId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/discovery/runs`,
  }),
  listDiscoveryCandidates: (businessId: string) => ({
    method: "GET",
    path: `/api/businesses/${businessId}/discovery/candidates`,
  }),
  listProviders: { method: "GET", path: "/api/providers" },
  getIssuePacket: (businessId: string, claimId: string) => ({
    method: "GET",
    path: `/api/businesses/${businessId}/issues/${claimId}/packet`,
  }),
  sendAgentMessage: (businessId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/agent/messages`,
  }),
  listSites: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/search/sites` }),
  createSite: (businessId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/search/sites`,
  }),
  listSiteRuns: (businessId: string, siteId: string) => ({
    method: "GET",
    path: `/api/businesses/${businessId}/search/sites/${siteId}/runs`,
  }),
  createSiteRun: (businessId: string, siteId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/search/sites/${siteId}/runs`,
  }),
  getSiteRun: (businessId: string, siteId: string, runId: string) => ({
    method: "GET",
    path: `/api/businesses/${businessId}/search/sites/${siteId}/runs/${runId}`,
  }),
  listSiteFindings: (businessId: string, siteId: string) => ({
    method: "GET",
    path: `/api/businesses/${businessId}/search/sites/${siteId}/findings`,
  }),
  getSiteFinding: (businessId: string, siteId: string, findingId: string) => ({
    method: "GET",
    path: `/api/businesses/${businessId}/search/sites/${siteId}/findings/${findingId}`,
  }),
  searchOverview: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/search/overview` }),
  prepareFix: (businessId: string, proposalId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/search/fixes/${proposalId}/prepare`,
  }),
  approveFix: (businessId: string, proposalId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/search/fixes/${proposalId}/approve`,
  }),
  applyFix: (businessId: string, proposalId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/search/fixes/${proposalId}/apply`,
  }),
  verifyFinding: (businessId: string, findingId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/search/findings/${findingId}/verify`,
  }),
  recordMutationIdentity: (businessId: string, mutationId: string) => ({
    method: "POST",
    path: `/api/businesses/${businessId}/search/mutations/${mutationId}/identity`,
  }),
  gscStatus: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/search/gsc` }),
} as const

// ---------------------------------------------------------------------------
// HTTP write-boundary request contracts. External JSON is untrusted: every
// write endpoint decodes unknown JSON through one of these schemas first
// (Schema.decodeUnknown) and returns 4xx on failure. Never `as`-cast.
// ---------------------------------------------------------------------------

const NonEmptyTrimmed = Schema.String.pipe(
  Schema.minLength(1),
  Schema.annotations({ description: "non-empty string" }),
)

// Timestamps must parse; otherwise they would become opaque SQL errors
// (500) instead of deterministic 4xx at the boundary.
const TimestampString = Schema.String.pipe(
  Schema.filter((s) => !Number.isNaN(Date.parse(s)), {
    description: "parseable timestamp",
  }),
)

export const SignUpRequest = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
  accountName: Schema.optional(Schema.String),
})
export type SignUpRequest = typeof SignUpRequest.Type

export const SignInRequest = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
})
export type SignInRequest = typeof SignInRequest.Type

export const CreateBusinessRequest = Schema.Struct({
  name: NonEmptyTrimmed,
})
export type CreateBusinessRequest = typeof CreateBusinessRequest.Type

export const FactValueTypeLiteral = Schema.Literal(
  "TEXT",
  "NUMBER",
  "CURRENCY",
  "BOOLEAN",
  "DATE",
  "URL",
  "ENUM",
)

export const FactSourceKindLiteral = Schema.Literal(
  "MANUAL",
  "WEBSITE",
  "PRODUCT_CATALOG",
  "POLICY_DOCUMENT",
  "OTHER",
)

export const CreateFactRequest = Schema.Struct({
  subject: NonEmptyTrimmed,
  predicate: NonEmptyTrimmed,
  valueText: NonEmptyTrimmed,
  valueType: FactValueTypeLiteral,
  validFrom: TimestampString,
  validUntil: Schema.optional(Schema.NullOr(TimestampString)),
  sourceKind: FactSourceKindLiteral,
})
export type CreateFactRequest = typeof CreateFactRequest.Type

export const SupersedeFactRequest = Schema.Struct({
  valueText: NonEmptyTrimmed,
  valueType: FactValueTypeLiteral,
  validFrom: TimestampString,
  validUntil: Schema.optional(Schema.NullOr(TimestampString)),
  sourceKind: FactSourceKindLiteral,
})
export type SupersedeFactRequest = typeof SupersedeFactRequest.Type

export const QuestionOriginLiteral = Schema.Literal(
  "BUSINESS_OWNER",
  "SALES",
  "SUPPORT",
  "CUSTOMER_INTERVIEW",
  "SEARCH_DATA",
  "OPERATOR_CONSTRUCTED",
  "OTHER",
)

export const CreateQuestionRequest = Schema.Struct({
  prompt: NonEmptyTrimmed,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  origin: QuestionOriginLiteral,
})
export type CreateQuestionRequest = typeof CreateQuestionRequest.Type

export const RunCheckRequest = Schema.Struct({
  questionId: Schema.UUID,
  provider: Schema.optional(Schema.Literal("mock", "9router")),
  // Requested model passes through to the provider: for 9router it must equal
  // the NINE_ROUTER_MODELS allowlist (enforced in the Effect provider), else the run fails closed.
  requestedModel: Schema.optional(Schema.NullOr(Schema.String)),
})
export type RunCheckRequest = typeof RunCheckRequest.Type

export const CreateSourceTargetRequest = Schema.Struct({
  url: NonEmptyTrimmed,
  control: Schema.Literal("OWNED", "THIRD_PARTY", "UNKNOWN"),
})
export type CreateSourceTargetRequest = typeof CreateSourceTargetRequest.Type

export const CreateSourceBindingRequest = Schema.Struct({
  factId: Schema.UUID,
  extractorKind: Schema.Literal("JSON_LD", "CSS_TEXT", "META_CONTENT"),
  extractorSelector: NonEmptyTrimmed,
  comparator: Schema.Literal("EXACT_TEXT", "BOOLEAN", "MONEY"),
})
export type CreateSourceBindingRequest = typeof CreateSourceBindingRequest.Type

export const CreateClaimRequest = Schema.Struct({
  observationId: Schema.UUID,
  text: NonEmptyTrimmed,
})
export type CreateClaimRequest = typeof CreateClaimRequest.Type

export const JudgmentVerdictLiteral = Schema.Literal(
  "SUPPORTED",
  "CONTRADICTED",
  "PARTIAL",
  "INSUFFICIENT_EVIDENCE",
)

export const CreateJudgmentRequest = Schema.Struct({
  claimId: Schema.UUID,
  verdict: JudgmentVerdictLiteral,
  notes: Schema.optional(Schema.NullOr(Schema.String)),
  factIds: Schema.Array(Schema.UUID),
})
export type CreateJudgmentRequest = typeof CreateJudgmentRequest.Type

// Recorded actions reference the controlled vocabulary from the evidence
// protocol. The actor is always HUMAN on this route; corrections travel as
// separate append-only rows and are out of scope here. An action may name
// the tracked source binding it acted on; before-evidence is resolved
// server-side from that binding's observations (never client-supplied, so
// there are no digest fields to spoof).
export const InterventionTypeLiteral = Schema.Literal(
  "SOURCE_UPDATED",
  "SOURCE_PUBLISHED",
  "THIRD_PARTY_CORRECTION_REQUESTED",
  "KNOWLEDGE_BASE_UPDATED",
  "STRUCTURED_DATA_UPDATED",
  "OTHER",
)

export const CreateInterventionRequest = Schema.Struct({
  type: InterventionTypeLiteral,
  target: NonEmptyTrimmed,
  performedAt: Schema.optional(TimestampString),
  notes: Schema.optional(Schema.NullOr(Schema.String)),
  sourceBindingId: Schema.optional(Schema.NullOr(Schema.UUID)),
})
export type CreateInterventionRequest = typeof CreateInterventionRequest.Type

// Durable re-check requests carry only an optional intervention link. The
// recheck re-runs the issue's own question with its own provider and
// requested model (resolved server-side from the issue lineage), so the
// body has no prompt, question, provider, or model fields to substitute.
export const CreateReobservationRequest = Schema.Struct({
  interventionId: Schema.optional(Schema.NullOr(Schema.UUID)),
})
export type CreateReobservationRequest = typeof CreateReobservationRequest.Type

// Agent assistance (read-only V1). The message is untrusted operator input:
// bounded length, no prompt/model/provider fields, no autonomous writes.
// The server answers only from account-scoped repositories and cites the
// rows it read. Anything that would write (run check, discovery run,
// intervention, recheck) is returned as a plan with a UI deep link; the
// human clicks to execute. Publishing stays manual by design.
export const AgentHistoryEntry = Schema.Struct({
  role: Schema.Literal("user", "agent"),
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
})
export type AgentHistoryEntry = typeof AgentHistoryEntry.Type

export const AgentMessageRequest = Schema.Struct({
  message: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
  history: Schema.optional(Schema.Array(AgentHistoryEntry).pipe(Schema.maxItems(10))),
})
export type AgentMessageRequest = typeof AgentMessageRequest.Type

// SEARCH_OPERATOR_V1 write-boundary contracts. URLs are untrusted operator
// input: http(s) only, validated server-side with SSRF-safe fetching.
export const CreateSiteRequest = Schema.Struct({
  rootUrl: NonEmptyTrimmed,
  adapterKind: Schema.optional(Schema.Literal("LOCAL_FILE", "GIT", "GITHUB")),
  repoRef: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
})
export type CreateSiteRequest = typeof CreateSiteRequest.Type

// patchSha256: the prepared change the reviewer saw. Required to approve an
// automated fix; approval fails if the prepared change has since changed.
export const ApproveFixRequest = Schema.Struct({
  approved: Schema.Boolean,
  patchSha256: Schema.optional(Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/))),
})
export type ApproveFixRequest = typeof ApproveFixRequest.Type

// Prepare the exact change an approval will bind to (target file + hashes).
export const PrepareFixRequest = Schema.Struct({
  filePath: Schema.optional(Schema.String),
})
export type PrepareFixRequest = typeof PrepareFixRequest.Type

// filePath, when sent, must equal the approved target (else 409).
// idempotencyKey defaults to `${proposalId}:${approvedPatchSha256}`; the same
// key always returns the original mutation result.
export const ApplyFixRequest = Schema.Struct({
  filePath: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200))),
})
export type ApplyFixRequest = typeof ApplyFixRequest.Type

// Externally observed mutation identity (branch/commit/PR created with
// normal git tooling, merge performed by a human). OpenRecord records what
// it observes; it never merges. Guarded transitions only.
export const RecordMutationIdentityRequest = Schema.Struct({
  branch: Schema.optional(Schema.String),
  commitSha: Schema.optional(Schema.String),
  prNumber: Schema.optional(Schema.Number),
  prUrl: Schema.optional(Schema.String),
  state: Schema.Literal("BRANCH_CREATED", "PR_OPEN", "MERGED", "FAILED"),
  detail: Schema.optional(Schema.String),
})
export type RecordMutationIdentityRequest = typeof RecordMutationIdentityRequest.Type

// Route identifiers: validate before touching the repository so malformed
// ids become 4xx, never opaque SQL errors.
export const RouteId = Schema.UUID
export const decodeRouteId = Schema.decodeUnknownEither(RouteId)

// Read-only prospect assay. Review identities are never request fields.
export const AssayRetrievalMode = Schema.Literal("NONE", "WEB_SEARCH", "PROVIDER_GROUNDING", "MANUAL_CAPTURE")
const AssayTerm = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100), Schema.filter(s => s.trim().length > 0))
export const RegisterAssaySourceRequest = Schema.Struct({
  url: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048)),
  subject: AssayTerm,
  planTerms: Schema.Array(AssayTerm).pipe(Schema.maxItems(20)),
  capabilityTerms: Schema.Array(AssayTerm).pipe(Schema.maxItems(20)),
})
export const RunAssayRequest = Schema.Struct({
  questionId: Schema.String.pipe(Schema.pattern(/^[0-9a-f-]{36}$/i)),
  provider: Schema.Literal("mock", "9router"),
  requestedModel: Schema.NullOr(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200))),
  retrievalMode: AssayRetrievalMode,
  n: Schema.optional(Schema.Int.pipe(Schema.between(1, 20))),
})
const AssayReviewReason = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000), Schema.filter(s => s.trim().length > 0))
export const ReviewAssayFactRequest = Schema.Struct({ decision: Schema.Literal("CONFIRMED", "INCORRECT_EXTRACTION", "AMBIGUOUS"), reason: AssayReviewReason })
export const RetractAssayFactRequest = Schema.Struct({ reason: AssayReviewReason })
export const ReviewAssayFindingRequest = Schema.Struct({ decision: Schema.Literal("REVIEWED_CORRECT", "REVIEWED_FALSE_POSITIVE", "REVIEWED_NOT_MEANINGFUL"), reason: AssayReviewReason })
export const AssayRoutes = {
  queue: (businessId: string) => `/api/businesses/${businessId}/assay`,
  sources: (businessId: string) => `/api/businesses/${businessId}/assay/sources`,
  groups: (businessId: string) => `/api/businesses/${businessId}/assay/groups`,
  reviewFact: (businessId: string, factId: string) => `/api/businesses/${businessId}/assay/facts/${factId}/review`,
  retractFact: (businessId: string, factId: string) => `/api/businesses/${businessId}/assay/facts/${factId}/retract`,
  reviewFinding: (businessId: string, findingId: string) => `/api/businesses/${businessId}/assay/findings/${findingId}/review`,
}
export const ASSAY_RETRIEVAL_LIMITATION = "This answer was produced without live web retrieval. Changes to public webpages are not expected to reliably alter this result within the pilot timeframe."
export interface AssayFact {
  id: string; subject: string; fact_type: string; normalized: unknown; source_url: string; source_id: string | null; supporting_span: string | null; extractor_version: string | null; status: string; valid_from: string | null; valid_until: string | null; final_url: string | null; fact_retracted: boolean; source_links: Array<{ sourceId: string; sourceUrl: string; finalUrl: string | null; snapshotAt: string | null; supportingSpan: string }>
}
export interface AssayFinding {
  id: string; verdict: string; sample_count: number; requested_n: number; contradict_count: number; unclear_count: number;
  retrieval_class: string; verification_eligible: boolean; retrieval_limitation: string | null; source_diagnosis: unknown; fact: AssayFact; question: string; group_status: string;
  missing_samples: Array<{ sampleNumber: number; failureClass: string }>;
  samples: Array<{ sampleNumber: number; status: string; failureClass: string | null; answer: string | null; comparison: string | null;
    supportingSpan: string | null; provider: string; observedModel: string | null; synthetic: boolean; rawDigest: string | null; retrievalMode: string | null; modelVersion: string | null; retrievalTool: string | null;
    requestParameters: unknown; collectedAt: string | null; citations: unknown[] }>
}
export interface AssayQueue {
  sources: Array<{ id: string; url: string; status: string; failure_class: string | null; fetched_text: string | null; fetched_at: string | null; final_url: string | null; raw_evidence_id: string | null }>;
  groups: Array<{ id: string; status: string; n: number; missing_samples: Array<{ sampleNumber: number; failureClass: string }> }>;
  facts: AssayFact[]; findings: AssayFinding[]
}
