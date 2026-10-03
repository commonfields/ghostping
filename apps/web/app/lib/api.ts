// Typed API client shared with the backend contract (packages/contracts).
// Most server state comes from these calls; ordinary React state covers UI-local interaction.
export class ApiError extends Error {
  readonly status: number
  readonly tag: string
  readonly body: Record<string, unknown>
  constructor(status: number, body: Record<string, unknown>) {
    const tag = typeof body["_tag"] === "string" ? body["_tag"] : "error"
    super(`${status} ${tag}`)
    this.status = status
    this.tag = tag
    this.body = body
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    throw new ApiError(res.status, body)
  }
  return (await res.json()) as T
}

export type Business = { id: string; name: string }

export type Fact = {
  id: string
  subject: string
  predicate: string
  valueText: string
  valueType: string
  status: string
  version: number
  validFrom: string
  validUntil: string | null
}

export type Question = { id: string; prompt: string; label: string | null; origin: string }

export type CheckRun = {
  id: string
  status: string
  provider: string
  queuedAt: string
  completedAt: string | null
  failureClass: string | null
  failureDetailSafe: string | null
  attemptCount: number
  observationId: string | null
  questionId: string
}

export type Observation = {
  id: string
  business_id: string
  answer_text: string
  provider: string
  observed_model: string | null
  requested_model?: string | null
  collected_at: string
  retrieval_mode: string
  raw_text?: string | null
}

export type Claim = { id: string; text: string; created_at?: string }

export type Issue = {
  claim_id: string
  claim_text: string
  state: IssueState
  verdict: string | null
  notes: string | null
  answer_text: string
  provider: string
  observed_model: string | null
  question_prompt: string | null
  facts: Array<{ id: string; predicate: string; valueText: string; status: string; version: number }>
  observation_id: string
  collected_at: string
}

export type IssueState = "WRONG" | "PARTIAL" | "UNKNOWN" | "NEEDS_REVIEW"

export type CitationEvidence = {
  uri: string
  title: string | null
  position: number | null
  attributed: boolean
  tracked: {
    binding_id: string
    target_id: string
    url: string
    control: string
    observed_value: string | null
    extraction_state: string | null
    finding: string
    finding_reason: string
    observed_at: string | null
  } | null
}

export type IssueWithEvidence = Issue & { citation_evidence: CitationEvidence[] }

export type FactProvenance = {
  manifestKey: string
  manifestDigest: string
  sourceRevision: string | null
  syncedAt: string
  sourceUrl: string | null
} | null

export type AuthorityMode = "HOSTED" | "REPOSITORY_MANIFEST"

export type RepresentationRow = {
  binding_id: string
  fact: { id: string; subject: string; predicate: string; valueText: string; valueType: string; status: string; version: number }
  source: { target_id: string; url: string; control: string }
  finding: { state: string; reason: string }
  effective_observation: {
    observation_id: string
    completed_at: string
    collection_state: string
    extracted_value: string | null
    extraction_state: string
  } | null
  latest_attempt: { completed_at: string; collection_state: string; failure: string | null } | null
  latest_successful_check: { observation_id: string; completed_at: string; collection_state: string } | null
}

export type RepresentationHistoryEntry = {
  observation_id: string
  completed_at: string
  collection_state: string
  state: string
  reason: string
  extracted_value: string | null
}

export type TrackedCitation = {
  uri: string
  title: string | null
  observation_id: string
  claim_id: string | null
  claim_text: string | null
  provider: string
  observed_model: string | null
  collected_at: string
}

export type RepresentationDetail = {
  binding: { id: string; factId: string; sourceTargetId: string; extractorKind: string; extractorSelector: string; comparator: string }
  fact: RepresentationRow["fact"] & { subject: string }
  source: { target_id: string; url: string; control: string }
  current: RepresentationRow | null
  history: RepresentationHistoryEntry[]
  citations: TrackedCitation[]
}

export type IssueDetail = Omit<Issue, "facts"> & {
  facts: Issue["facts"]
  citation_evidence: CitationEvidence[]
}

export type StoredCitation = { uri: string | null; title: string | null; position: number | null; attributed: boolean }

export type Overview = { completed: string; last_checked: string | null; unreviewed: string; needs_attention: string }

export const Auth = {
  me: () => api<{ userId: string; accountId: string }>("/api/auth/me"),
  signup: (email: string, password: string) =>
    api<{ userId: string; accountId: string }>("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  signin: (email: string, password: string) =>
    api<{ userId: string; accountId: string }>("/api/auth/signin", { method: "POST", body: JSON.stringify({ email, password }) }),
  signout: () => api<{ ok: boolean }>("/api/auth/signout", { method: "POST" }),
}

export const Businesses = {
  list: () => api<{ businesses: Business[] }>("/api/businesses"),
  create: (name: string) => api<{ business: Business }>("/api/businesses", { method: "POST", body: JSON.stringify({ name }) }),
}

export const Facts = {
  list: (businessId: string) =>
    api<{
      facts: Fact[]
      conflicts: Array<{ a: string; b: string }>
      authority: { mode: AuthorityMode }
      provenance: Record<string, FactProvenance>
    }>(`/api/businesses/${businessId}/facts`),
  create: (businessId: string, input: Record<string, unknown>) =>
    api<{ fact: Fact }>(`/api/businesses/${businessId}/facts`, { method: "POST", body: JSON.stringify(input) }),
  supersede: (businessId: string, factId: string, input: Record<string, unknown>) =>
    api<{ fact: Fact }>(`/api/businesses/${businessId}/facts/${factId}/supersede`, { method: "POST", body: JSON.stringify(input) }),
  retire: (businessId: string, factId: string) =>
    api<{ fact: Fact }>(`/api/businesses/${businessId}/facts/${factId}/retire`, { method: "POST" }),
  history: (businessId: string, factId: string) =>
    api<{ fact: Fact; history: Array<Fact & { provenance: FactProvenance }> }>(`/api/businesses/${businessId}/facts/${factId}/history`),
}

export const Questions = {
  list: (businessId: string) => api<{ questions: Question[] }>(`/api/businesses/${businessId}/questions`),
  create: (businessId: string, input: { prompt: string; label: string | null; origin: string }) =>
    api<{ question: Question }>(`/api/businesses/${businessId}/questions`, { method: "POST", body: JSON.stringify(input) }),
}

export const Checks = {
  list: (businessId: string) => api<{ checkRuns: CheckRun[] }>(`/api/businesses/${businessId}/check-runs`),
  run: (businessId: string, questionId: string, provider: "mock" | "9router" = "mock") =>
    api<{ checkRun: CheckRun }>(`/api/businesses/${businessId}/check-runs`, {
      method: "POST",
      body: JSON.stringify({ questionId, provider }),
    }),
}

export const Observations = {
  get: (observationId: string) =>
    api<{ observation: Observation; claims: Claim[]; citations: StoredCitation[] }>(`/api/observations/${observationId}`),
}

export const Representations = {
  list: (businessId: string) => api<{ representations: RepresentationRow[] }>(`/api/businesses/${businessId}/representations`),
  get: (businessId: string, bindingId: string) =>
    api<RepresentationDetail>(`/api/businesses/${businessId}/representations/${bindingId}`),
}

// Representation Discovery V1 read/scan contract. The backend serves these
// under /api/businesses/:id/discovery/*; until it lands, calls surface the
// server error and pages render honest empty states instead of guessing.
export type DiscoveryScope = {
  id: string
  business_id: string
  root_url: string
  canonical_origin: string | null
  path_prefix: string | null
  enabled: boolean
  ownership_assertion: string
  created_at: string
}

export type DiscoveryRunState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED"

export type DiscoveryRun = {
  id: string
  scope_id: string
  state: DiscoveryRunState
  queued_at: string
  started_at: string | null
  completed_at: string | null
  partial_reason: string | null
  failure_reason: string | null
  pages_checked: number
  pages_skipped: number
  candidates_found: number
}

// Discovery-local match relation. Deliberately separate from the
// representation finding states (IN_SYNC/DRIFT/UNKNOWN): a candidate is not
// a tracked representation until it is explicitly configured.
export type DiscoveryCandidateRelation = "CURRENT" | "HISTORICAL" | "MIXED"

export type DiscoveryCandidate = {
  id: string
  run_id: string
  fact_id: string
  fact_predicate: string
  approved_value: string
  found_value: string
  page_url: string
  relation: DiscoveryCandidateRelation
  found_via: string
  scanned_at: string
  truth_changed_since_scan: boolean
}

export const Discovery = {
  listScopes: (businessId: string) => api<{ scopes: DiscoveryScope[] }>(`/api/businesses/${businessId}/discovery/scopes`),
  createScope: (businessId: string, root_url: string) =>
    api<{ scope: DiscoveryScope }>(`/api/businesses/${businessId}/discovery/scopes`, {
      method: "POST",
      body: JSON.stringify({ root_url }),
    }),
  listRuns: (businessId: string, scope_id: string) =>
    api<{ runs: DiscoveryRun[] }>(`/api/businesses/${businessId}/discovery/runs?scope_id=${encodeURIComponent(scope_id)}`),
  triggerRun: (businessId: string, scope_id: string) =>
    api<{ run: DiscoveryRun }>(`/api/businesses/${businessId}/discovery/runs`, {
      method: "POST",
      body: JSON.stringify({ scope_id }),
    }),
  listCandidates: (businessId: string, query: { scope_id: string; run_id?: string }) => {
    const params = new URLSearchParams({ scope_id: query.scope_id })
    if (query.run_id) params.set("run_id", query.run_id)
    return api<{ candidates: DiscoveryCandidate[] }>(`/api/businesses/${businessId}/discovery/candidates?${params.toString()}`)
  },
}

export const Claims = {
  create: (observationId: string, text: string) =>
    api<{ claim: { id: string } }>("/api/claims", { method: "POST", body: JSON.stringify({ observationId, text }) }),
}

export const Judgments = {
  create: (claimId: string, verdict: string, factIds: Array<string>, notes?: string) =>
    api("/api/judgments", { method: "POST", body: JSON.stringify({ claimId, verdict, factIds, notes: notes ?? null }) }),
}

export const Issues = {
  list: (businessId: string) => api<{ issues: IssueWithEvidence[] }>(`/api/businesses/${businessId}/issues`),
  get: (businessId: string, claimId: string) => api<IssueDetail>(`/api/businesses/${businessId}/issues/${claimId}`),
  overview: (businessId: string) => api<{ overview: Overview }>(`/api/businesses/${businessId}/overview`),
}

export type VerdictCounts = { supported: number; wrong: number; partial: number; unknown: number; unreviewed: number }

export type Analytics = {
  range: { days: number; from: string; to: string }
  current: VerdictCounts & { checks: number; answers: number; failed: number }
  previous: VerdictCounts & { checks: number; answers: number }
  daily: Array<VerdictCounts & { date: string; checks: number; failed: number }>
  providers: Array<VerdictCounts & { provider: string; answers: number }>
  questions: Array<VerdictCounts & { id: string; prompt: string; label: string | null; checks: number; last_checked_at: string | null }>
  facts: Array<VerdictCounts & { id: string; predicate: string; value_text: string; status: string }>
}

export const AnalyticsApi = {
  get: (businessId: string, days: number) => api<{ analytics: Analytics }>(`/api/businesses/${businessId}/analytics?days=${days}`),
}
