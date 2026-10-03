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
  facts: Array<{ id: string; predicate: string; valueText: string; status: string }>
  observation_id: string
  collected_at: string
}

export type IssueState = "WRONG" | "PARTIAL" | "UNKNOWN" | "NEEDS_REVIEW"

export type Overview = { completed: string; last_checked: string | null; unreviewed: string; needs_attention: string }

// TEMP: frontend-only mocks so the full design is visible without a backend.
// Set to false to use the real API.
const USE_MOCK = true
import { mockAddBusiness, mockAddClaim, mockAddFact, mockAddQuestion, mockAnalytics, mockBusinesses, mockCheckRuns, mockFacts, mockIssues, mockObservations, mockOverviews, mockQueueCheck, mockQuestions } from "./mock"

export const Auth = {
  me: () => (USE_MOCK ? Promise.resolve({ userId: "user-dev", accountId: "dev-local" }) : api<{ userId: string; accountId: string }>("/api/auth/me")),
  signup: (email: string, password: string) =>
    USE_MOCK ? Promise.resolve({ userId: "user-dev", accountId: "dev-local" }) : api<{ userId: string; accountId: string }>("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  signin: (email: string, password: string) =>
    USE_MOCK ? Promise.resolve({ userId: "user-dev", accountId: "dev-local" }) : api<{ userId: string; accountId: string }>("/api/auth/signin", { method: "POST", body: JSON.stringify({ email, password }) }),
  signout: () => (USE_MOCK ? Promise.resolve({ ok: true }) : api<{ ok: boolean }>("/api/auth/signout", { method: "POST" })),
}

export const Businesses = {
  list: () => (USE_MOCK ? Promise.resolve({ businesses: mockBusinesses }) : api<{ businesses: Business[] }>("/api/businesses")),
  create: (name: string) => (USE_MOCK ? Promise.resolve({ business: mockAddBusiness(name) }) : api<{ business: Business }>("/api/businesses", { method: "POST", body: JSON.stringify({ name }) })),
}

export const Facts = {
  list: (businessId: string) =>
    USE_MOCK ? Promise.resolve({ facts: mockFacts[businessId] ?? [], conflicts: [] }) : api<{ facts: Fact[]; conflicts: Array<{ a: string; b: string }> }>(`/api/businesses/${businessId}/facts`),
  create: (businessId: string, input: Record<string, unknown>) =>
    USE_MOCK ? Promise.resolve({ fact: mockAddFact(businessId, input) }) : api<{ fact: Fact }>(`/api/businesses/${businessId}/facts`, { method: "POST", body: JSON.stringify(input) }),
  supersede: (businessId: string, factId: string, input: Record<string, unknown>) =>
    USE_MOCK ? Promise.resolve({ fact: mockAddFact(businessId, { ...input, subject: mockFacts[businessId]?.find((f) => f.id === factId)?.subject ?? "", predicate: mockFacts[businessId]?.find((f) => f.id === factId)?.predicate ?? "" }) }) : api<{ fact: Fact }>(`/api/businesses/${businessId}/facts/${factId}/supersede`, { method: "POST", body: JSON.stringify(input) }),
  retire: (businessId: string, factId: string) =>
    USE_MOCK
      ? Promise.resolve({ fact: { ...(mockFacts[businessId]?.find((f) => f.id === factId) ?? mockAddFact(businessId, {})), status: "RETIRED" } })
      : api<{ fact: Fact }>(`/api/businesses/${businessId}/facts/${factId}/retire`, { method: "POST" }),
}

export const Questions = {
  list: (businessId: string) => (USE_MOCK ? Promise.resolve({ questions: mockQuestions[businessId] ?? [] }) : api<{ questions: Question[] }>(`/api/businesses/${businessId}/questions`)),
  create: (businessId: string, input: { prompt: string; label: string | null; origin: string }) =>
    USE_MOCK ? Promise.resolve({ question: mockAddQuestion(businessId, input) }) : api<{ question: Question }>(`/api/businesses/${businessId}/questions`, { method: "POST", body: JSON.stringify(input) }),
}

export const Checks = {
  list: (businessId: string) => (USE_MOCK ? Promise.resolve({ checkRuns: mockCheckRuns[businessId] ?? [] }) : api<{ checkRuns: CheckRun[] }>(`/api/businesses/${businessId}/check-runs`)),
  run: (businessId: string, questionId: string, provider: "mock" | "9router" = "mock") =>
    USE_MOCK
      ? Promise.resolve({ checkRun: mockQueueCheck(businessId, questionId, provider) })
      : api<{ checkRun: CheckRun }>(`/api/businesses/${businessId}/check-runs`, {
          method: "POST",
          body: JSON.stringify({ questionId, provider }),
        }),
}

export const Observations = {
  get: (observationId: string) =>
    USE_MOCK ? Promise.resolve(mockObservations[observationId] ?? { observation: mockObservations["obs-1"]!.observation, claims: [] }) : api<{ observation: Observation; claims: Claim[] }>(`/api/observations/${observationId}`),
}

export const Claims = {
  create: (observationId: string, text: string) =>
    USE_MOCK ? Promise.resolve({ claim: mockAddClaim(observationId, text) }) : api<{ claim: { id: string } }>("/api/claims", { method: "POST", body: JSON.stringify({ observationId, text }) }),
}

export const Judgments = {
  create: (claimId: string, verdict: string, factIds: Array<string>, notes?: string) =>
    USE_MOCK ? Promise.resolve({ ok: true }) : api("/api/judgments", { method: "POST", body: JSON.stringify({ claimId, verdict, factIds, notes: notes ?? null }) }),
}

export const Issues = {
  list: (businessId: string) => (USE_MOCK ? Promise.resolve({ issues: mockIssues[businessId] ?? [] }) : api<{ issues: Issue[] }>(`/api/businesses/${businessId}/issues`)),
  overview: (businessId: string) =>
    USE_MOCK ? Promise.resolve({ overview: mockOverviews[businessId] ?? { completed: "0", last_checked: null, unreviewed: "0", needs_attention: "0" } }) : api<{ overview: Overview }>(`/api/businesses/${businessId}/overview`),
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
  get: (businessId: string, days: number) =>
    USE_MOCK ? Promise.resolve({ analytics: mockAnalytics(businessId, days) }) : api<{ analytics: Analytics }>(`/api/businesses/${businessId}/analytics?days=${days}`),
}
