// Single typed contract shared by apps/api and apps/web.
// Derives request/response shapes from Effect Schema (domain package).
import { Schema } from "effect"

export const WorkerJobV1 = Schema.Struct({
  contract_version: Schema.Literal("ghostping-worker-job-v1"),
  run_id: Schema.String,
  provider: Schema.String,
  model: Schema.NullOr(Schema.String),
  prompt: Schema.String,
})
export type WorkerJobV1 = typeof WorkerJobV1.Type

export const WorkerResultV1 = Schema.Struct({
  contract_version: Schema.Literal("ghostping-worker-result-v1"),
  run_id: Schema.String,
  status: Schema.Literal("succeeded", "failed"),
  provider: Schema.String,
  requested_model: Schema.NullOr(Schema.String),
  observed_model: Schema.NullOr(Schema.String),
  collected_at: Schema.String,
  answer_text: Schema.NullOr(Schema.String),
  retrieval_mode: Schema.Literal("unknown", "grounded", "parametric"),
  citations: Schema.Array(
    Schema.Struct({
      uri: Schema.NullOr(Schema.String),
      title: Schema.NullOr(Schema.String),
      position: Schema.NullOr(Schema.Number),
      attributed: Schema.Boolean,
    }),
  ),
  raw_digest: Schema.String,
  raw_response: Schema.Unknown,
  // Additive result-v1 fields. Older golden fixtures remain decodable; new
  // workers preserve exact response bytes rather than reconstructing them.
  raw_bytes_hex: Schema.optional(Schema.NullOr(Schema.String)),
  raw_content_type: Schema.optional(Schema.NullOr(Schema.String)),
  provider_metadata: Schema.optional(Schema.Unknown),
  failure_class: Schema.NullOr(Schema.String),
  failure_detail_safe: Schema.NullOr(Schema.String),
})
export type WorkerResultV1 = typeof WorkerResultV1.Type

export const JOB_CONTRACT_VERSION = "ghostping-worker-job-v1" as const
export const RESULT_CONTRACT_VERSION = "ghostping-worker-result-v1" as const

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
  overview: (businessId: string) => ({ method: "GET", path: `/api/businesses/${businessId}/overview` }),
} as const

export const decodeWorkerJob = Schema.decodeUnknownSync(WorkerJobV1)
export const decodeWorkerResult = Schema.decodeUnknownSync(WorkerResultV1)
export const encodeWorkerJob = Schema.encodeSync(WorkerJobV1)
export const encodeWorkerResult = Schema.encodeSync(WorkerResultV1)

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
  // Requested model passes through to the worker: for 9router it must equal
  // the NINE_ROUTER_MODEL pin (enforced in Rust), else the run fails closed.
  requestedModel: Schema.optional(Schema.NullOr(Schema.String)),
})
export type RunCheckRequest = typeof RunCheckRequest.Type

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

// Route identifiers: validate before touching the repository so malformed
// ids become 4xx, never opaque SQL errors.
export const RouteId = Schema.UUID
export const decodeRouteId = Schema.decodeUnknownEither(RouteId)
