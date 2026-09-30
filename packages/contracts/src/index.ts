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
