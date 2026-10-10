// Typed API client shared with the backend contract (packages/contracts).
// Most server state comes from these calls; ordinary React state covers UI-local interaction.
import { AssayRoutes, type AssayQueue, type RegisterAssaySourceRequest, type RunAssayRequest, type ReviewAssayFactRequest, type ReviewAssayFindingRequest, Routes } from "@openrecord/contracts"
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
  run: (businessId: string, questionId: string, provider: "mock" | "9router" = "mock", requestedModel?: string | null) =>
    api<{ checkRun: CheckRun }>(`/api/businesses/${businessId}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        questionId,
        provider,
        ...(provider === "9router" && requestedModel ? { requestedModel } : {}),
      }),
    }),
}

export type ProviderInfo = { id: string; enabled: boolean; models: string[] }

export const Providers = {
  list: () => api<{ providers: ProviderInfo[]; assaySyntheticEnabled: boolean }>("/api/providers"),
}

export const Packets = {
  get: (businessId: string, claimId: string) =>
    api<{ packet: unknown; digest: string; rendered: string }>(Routes.getIssuePacket(businessId, claimId).path),
}

export type AgentToolCall = { tool: string; summary: string }
export type AgentCitation = { kind: string; id: string; text: string }

export const Agent = {
  send: (businessId: string, message: string) =>
    api<{ reply: string; toolCalls: AgentToolCall[]; citations: AgentCitation[] }>(Routes.sendAgentMessage(businessId).path, {
      method: "POST",
      body: JSON.stringify({ message }),
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
  createTarget: (businessId: string, input: { url: string; control: string }) => {
    const route = Routes.createSourceTarget(businessId)
    return api<{ target: { id: string } }>(route.path, {
      method: route.method,
      body: JSON.stringify(input),
    })
  },
  createBinding: (
    businessId: string,
    targetId: string,
    input: { factId: string; extractorKind: string; extractorSelector: string; comparator: string },
  ) => {
    const route = Routes.createSourceBinding(businessId, targetId)
    return api<{ binding: { id: string } }>(route.path, {
      method: route.method,
      body: JSON.stringify(input),
    })
  },
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

export type DiscoveryCandidateEvidence = {
  surface: string
  locator: string
  snippet: string
  relation: "CURRENT" | "HISTORICAL"
}

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
  evidence?: DiscoveryCandidateEvidence[]
}

export const Discovery = {
  listScopes: (businessId: string) => api<{ scopes: DiscoveryScope[] }>(Routes.listDiscoveryScopes(businessId).path),
  createScope: (businessId: string, root_url: string) => {
    const route = Routes.createDiscoveryScope(businessId)
    return api<{ scope: DiscoveryScope }>(route.path, {
      method: route.method,
      body: JSON.stringify({ root_url }),
    })
  },
  listRuns: (businessId: string, scope_id: string) =>
    api<{ runs: DiscoveryRun[] }>(`${Routes.listDiscoveryRuns(businessId).path}?scope_id=${encodeURIComponent(scope_id)}`),
  triggerRun: (businessId: string, scope_id: string) => {
    const route = Routes.createDiscoveryRun(businessId)
    return api<{ run: DiscoveryRun }>(route.path, {
      method: route.method,
      body: JSON.stringify({ scope_id }),
    })
  },
  listCandidates: (businessId: string, query: { scope_id: string; run_id?: string }) => {
    const params = new URLSearchParams({ scope_id: query.scope_id })
    if (query.run_id) params.set("run_id", query.run_id)
    return api<{ candidates: DiscoveryCandidate[] }>(`${Routes.listDiscoveryCandidates(businessId).path}?${params.toString()}`)
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

export type Intervention = {
  id: string
  businessId: string
  issueIds: string[]
  type: string
  target: string
  performedAt: string
  actor: string
  actorId: string | null
  notes: string | null
  evidenceBeforeDigest: string | null
  evidenceAfterDigest: string | null
  supersedesId: string | null
  correctionReason: string | null
  createdAt: string
}

export const Interventions = {
  list: (businessId: string, claimId: string) =>
    api<{ interventions: Intervention[] }>(`/api/businesses/${businessId}/issues/${claimId}/interventions`),
  create: (
    businessId: string,
    claimId: string,
    input: { type: string; target: string; notes?: string | null; performedAt?: string; evidenceBeforeDigest?: string | null; evidenceAfterDigest?: string | null },
  ) =>
    api<{ intervention: Intervention }>(`/api/businesses/${businessId}/issues/${claimId}/interventions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
}

// Issue loop: one derived view over an issue, its recorded actions, linked
// source verification, and before/after rechecks. Read-only; comparison
// wording arrives from the server display copy.
export type LoopCitation = { uri: string | null; title: string | null; position: number | null; attributed: boolean }

export type LoopSide = {
  observationId: string
  provider: string
  requestedModel: string | null
  observedModel: string | null
  collectedAt: string
  answerText: string
  citations: LoopCitation[]
  claimId: string | null
  claimText: string | null
  judgmentId: string | null
  verdict: string | null
}

export type LoopComparison = {
  reobservationId: string
  interventionId: string | null
  before: LoopSide
  after: LoopSide
  matchClassification: string
  observedChange: string
  outcome: string
  causalAttribution: "UNKNOWN"
  measurementStatus: string
  displayCopy: string
  comparabilityExplanation: string
}

export type IssueLoop = {
  issue: { claimId: string; observationId: string; verdict: string | null; state: string }
  originalObservation: LoopSide
  originalJudgment: { id: string; verdict: string; notes: string | null; createdAt: string } | null
  interventions: Intervention[]
  sourceVerification: {
    bindingId: string | null
    alignment: string
    change: string
    beforeObservationId: string | null
    afterObservationId: string | null
    beforeValue: string | null
    afterValue: string | null
    documentChanged: boolean | null
    detail: string
  }
  reobservationAttempts: Array<{
    intentId: string
    interventionId: string | null
    checkRunId: string
    state: string
    queuedAt: string | null
    startedAt: string | null
    completedAt: string | null
    failureClass: string | null
    failureDetailSafe: string | null
    observationId: string | null
    reobservationId: string | null
  }>
  completedReobservations: Array<{ id: string; interventionId: string | null; observationId: string; createdAt: string; after: LoopSide }>
  latestComparison: LoopComparison | null
  explicitUnknowns: Array<{ subjectId: string; field: string }>
}

// Rechecks: the reobservations POST endpoint lands with the parallel API
// track; until then calls surface the server error and the UI shows it
// honestly instead of guessing.
export const Rechecks = {
  getLoop: (businessId: string, claimId: string) =>
    api<{ loop: IssueLoop }>(Routes.getIssueLoop(businessId, claimId).path),
  create: (businessId: string, claimId: string, input?: { interventionId?: string | null }) => {
    const route = Routes.requestReobservation(businessId, claimId)
    return api<{ checkRun: unknown; intent: unknown }>(route.path, {
      method: route.method,
      body: JSON.stringify({ interventionId: input?.interventionId ?? null }),
    })
  },
}

export const Sources = {
  check: (businessId: string, bindingId: string) => {
    const route = Routes.checkRepresentation(businessId, bindingId)
    return api<{
      observation: { id: string; collection_state: string; failure: string | null }
      values: Array<{ id: string; extraction_state: string }>
      finding: { state: string; reason: string }
    }>(route.path, { method: route.method })
  },
}

export type VerdictCounts = { supported: number; wrong: number; partial: number; unknown: number; unreviewed: number }

export type Analytics = {
  range: { days: number; from: string; to: string }
  current: VerdictCounts & { checks: number; answers: number; failed: number }
  previous: VerdictCounts & { checks: number; answers: number }
  daily: Array<VerdictCounts & { date: string; checks: number; failed: number }>
  providers: Array<VerdictCounts & { provider: string; answers: number; prev_answers: number }>
  providerDaily: Array<{ date: string; provider: string; mentions: number }>
  questions: Array<VerdictCounts & { id: string; prompt: string; label: string | null; checks: number; last_checked_at: string | null }>
  facts: Array<VerdictCounts & { id: string; predicate: string; value_text: string; status: string }>
}

export const AnalyticsApi = {
  get: (businessId: string, days: number) => api<{ analytics: Analytics }>(`/api/businesses/${businessId}/analytics?days=${days}`),
}

// SEARCH_OPERATOR_V1: website inspection -> finding -> fix -> verification.
// Concrete state only: counts grouped by status, never a single number.
export type SiteTarget = {
  id: string
  businessId: string
  rootUrl: string
  canonicalOrigin: string
  pathPrefix: string
  enabled: boolean
  adapterKind: string
  createdAt: string
}

export type SiteRun = {
  id: string
  businessId: string
  siteTargetId: string
  state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED"
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
  failureClass: string | null
  failureDetailSafe: string | null
  urlsInspected: number
  urlsFailed: number
  findingsProduced: number
}

export type SiteFinding = {
  id: string
  businessId: string
  siteTargetId: string
  url: string
  canonicalUrl: string
  findingKind: string
  severity: string
  category: string
  status: string
  detectedAt: string
  evidence: Record<string, unknown>
  diagnosis: string
  recommendedAction: string
  confidence: string
}

export type FindingHistoryEntry = {
  id: string
  findingId: string
  fromStatus: string | null
  toStatus: string
  actor: string
  detail: string | null
  createdAt: string
}

export type FixProposal = {
  id: string
  findingId: string
  fixKind: string
  target: string
  filePath: string | null
  beforeText: string | null
  afterText: string | null
  patch: string | null
  rationale: string
  risk: string
  classification: string
  requiresApproval: boolean
  status: string
  /** Exact prepared change an approval binds to (null until prepared). */
  patchSha256: string | null
  approvedPatchSha256: string | null
}

export type SiteMutation = {
  id: string
  findingId: string
  adapterKind: string
  branch: string | null
  commitSha: string | null
  prNumber: number | null
  prUrl: string | null
  state: string
  detail: string | null
  createdAt: string
  targetPath: string | null
  failureCode: string | null
}

export type SiteVerification = {
  id: string
  findingId: string
  result: string
  detail: string | null
  checkedAt: string
}

export type SearchOverview = {
  sites: Array<{ id: string; rootUrl: string; adapterKind: string }>
  website: string | null
  lastInspection: string | null
  urlsInspected: number
  openFindings: number
  awaitingApproval: number
  fixesApplied: number
  verificationPending: number
  verifiedFixes: number
  needsAttention: SiteFinding[]
}

export const Search = {
  overview: (businessId: string) => api<{ overview: SearchOverview }>(Routes.searchOverview(businessId).path),
  listSites: (businessId: string) => api<{ sites: SiteTarget[] }>(Routes.listSites(businessId).path),
  createSite: (businessId: string, rootUrl: string) => {
    const route = Routes.createSite(businessId)
    return api<{ site: SiteTarget }>(route.path, { method: route.method, body: JSON.stringify({ rootUrl }) })
  },
  listRuns: (businessId: string, siteId: string) =>
    api<{ runs: SiteRun[] }>(Routes.listSiteRuns(businessId, siteId).path),
  triggerRun: (businessId: string, siteId: string) => {
    const route = Routes.createSiteRun(businessId, siteId)
    return api<{ run: SiteRun }>(route.path, { method: route.method })
  },
  getRun: (businessId: string, siteId: string, runId: string) =>
    api<{ run: SiteRun; observations: Array<Record<string, unknown>>; events: Array<{ kind: string }> }>(
      Routes.getSiteRun(businessId, siteId, runId).path,
    ),
  listFindings: (businessId: string, siteId: string) =>
    api<{ findings: SiteFinding[] }>(Routes.listSiteFindings(businessId, siteId).path),
  getFinding: (businessId: string, siteId: string, findingId: string) =>
    api<{
      finding: SiteFinding
      history: FindingHistoryEntry[]
      proposals: FixProposal[]
      mutations: SiteMutation[]
      verifications: SiteVerification[]
    }>(Routes.getSiteFinding(businessId, siteId, findingId).path),
  prepareFix: (businessId: string, proposalId: string) => {
    const route = Routes.prepareFix(businessId, proposalId)
    return api<{ proposal: FixProposal; patch: string; approvalInvalidated: boolean }>(route.path, { method: route.method, body: JSON.stringify({}) })
  },
  approveFix: (businessId: string, proposalId: string, approved: boolean, patchSha256: string | null) => {
    const route = Routes.approveFix(businessId, proposalId)
    // The hash of the diff on screen: approval fails if the prepared change has since changed.
    const body = patchSha256 === null ? { approved } : { approved, patchSha256 }
    return api<{ proposal: FixProposal }>(route.path, { method: route.method, body: JSON.stringify(body) })
  },
  applyFix: (businessId: string, proposalId: string) => {
    const route = Routes.applyFix(businessId, proposalId)
    return api<{ mutation: SiteMutation; patch: string }>(route.path, { method: route.method, body: JSON.stringify({}) })
  },
  verifyFinding: (businessId: string, findingId: string) => {
    const route = Routes.verifyFinding(businessId, findingId)
    return api<{ verification: string; run: SiteRun | null }>(route.path, { method: route.method })
  },
  recordMutationIdentity: (businessId: string, mutationId: string, input: { branch?: string; commitSha?: string; prNumber?: number; prUrl?: string; state: string; detail?: string }) => {
    const route = Routes.recordMutationIdentity(businessId, mutationId)
    return api<{ mutation: SiteMutation }>(route.path, { method: route.method, body: JSON.stringify(input) })
  },
  gsc: (businessId: string) =>
    api<{ status: string; detail: string; properties: Array<{ propertyUri: string; status: string }>; source: string }>(
      Routes.gscStatus(businessId).path,
    ),
}

export const Assay = {
  queue: (businessId: string) => api<AssayQueue>(AssayRoutes.queue(businessId)),
  registerSource: (businessId: string, input: typeof RegisterAssaySourceRequest.Type) =>
    api(AssayRoutes.sources(businessId), { method: "POST", body: JSON.stringify(input) }),
  run: (businessId: string, input: typeof RunAssayRequest.Type) =>
    api(AssayRoutes.groups(businessId), { method: "POST", body: JSON.stringify(input) }),
  reviewFact: (businessId: string, factId: string, input: typeof ReviewAssayFactRequest.Type) =>
    api(AssayRoutes.reviewFact(businessId, factId), { method: "POST", body: JSON.stringify(input) }),
  reviewFinding: (businessId: string, findingId: string, input: typeof ReviewAssayFindingRequest.Type) =>
    api(AssayRoutes.reviewFinding(businessId, findingId), { method: "POST", body: JSON.stringify(input) }),
}
