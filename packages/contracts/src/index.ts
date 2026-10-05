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

// Route identifiers: validate before touching the repository so malformed
// ids become 4xx, never opaque SQL errors.
export const RouteId = Schema.UUID
export const decodeRouteId = Schema.decodeUnknownEither(RouteId)
