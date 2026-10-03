// TEMP frontend-only mock data (no backend needed). Set USE_MOCK=false in lib/api.ts to use the real API.
import type { Analytics, Business, CheckRun, Claim, Fact, Issue, Observation, Overview, Question } from "./api"

const now = new Date()
const iso = (d: Date) => d.toISOString()
const hoursAgo = (h: number) => iso(new Date(now.getTime() - h * 3600_000))
const daysAgo = (d: number) => iso(new Date(now.getTime() - d * 86_400_000))
const ymd = (d: number) => {
  const t = new Date(now.getTime() - d * 86_400_000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`
}

export const mockBusinesses: Business[] = [
  { id: "biz-northstar", name: "Northstar Software" },
  { id: "biz-harbor", name: "Harbor Coffee Roasters" },
]

const northstarFacts: Fact[] = [
  { id: "fact-price", subject: "northstar", predicate: "monthly_price", valueText: "$39", valueType: "CURRENCY", status: "ACTIVE", version: 2, validFrom: "2026-01-01T00:00:00Z", validUntil: null },
  { id: "fact-sf", subject: "northstar", predicate: "salesforce_integration", valueText: "false", valueType: "BOOLEAN", status: "ACTIVE", version: 1, validFrom: "2026-01-01T00:00:00Z", validUntil: null },
  { id: "fact-cancel", subject: "northstar", predicate: "cancellation_period", valueText: "24 hours", valueType: "TEXT", status: "ACTIVE", version: 1, validFrom: "2026-01-01T00:00:00Z", validUntil: null },
  { id: "fact-trial", subject: "northstar", predicate: "free_trial", valueText: "14 days", valueType: "TEXT", status: "ACTIVE", version: 1, validFrom: "2026-02-01T00:00:00Z", validUntil: null },
  { id: "fact-price-old", subject: "northstar", predicate: "monthly_price", valueText: "$29", valueType: "CURRENCY", status: "SUPERSEDED", version: 1, validFrom: "2025-06-01T00:00:00Z", validUntil: "2026-01-01T00:00:00Z" },
]

const harborFacts: Fact[] = [
  { id: "fact-beans", subject: "harbor", predicate: "single_origin_price", valueText: "$22", valueType: "CURRENCY", status: "ACTIVE", version: 1, validFrom: "2026-01-15T00:00:00Z", validUntil: null },
  { id: "fact-ship", subject: "harbor", predicate: "free_shipping_threshold", valueText: "$35", valueType: "CURRENCY", status: "ACTIVE", version: 1, validFrom: "2026-01-15T00:00:00Z", validUntil: null },
]

export const mockFacts: Record<string, Fact[]> = { "biz-northstar": [...northstarFacts], "biz-harbor": [...harborFacts] }

const northstarQuestions: Question[] = [
  { id: "q-price", prompt: "How much does Northstar cost?", label: "Pricing", origin: "BUSINESS_OWNER" },
  { id: "q-sf", prompt: "Does Northstar integrate with Salesforce?", label: "Integrations", origin: "SALES" },
  { id: "q-cancel", prompt: "What is Northstar's cancellation policy?", label: "Cancellation", origin: "SUPPORT" },
]

const harborQuestions: Question[] = [
  { id: "q-beans", prompt: "How much is Harbor's single origin bag?", label: "Pricing", origin: "BUSINESS_OWNER" },
]

export const mockQuestions: Record<string, Question[]> = { "biz-northstar": [...northstarQuestions], "biz-harbor": [...harborQuestions] }

export const mockCheckRuns: Record<string, CheckRun[]> = {
  "biz-northstar": [
    { id: "run-1", status: "SUCCEEDED", provider: "mock", queuedAt: hoursAgo(3), completedAt: hoursAgo(3), failureClass: null, failureDetailSafe: null, attemptCount: 1, observationId: "obs-1", questionId: "q-price" },
    { id: "run-2", status: "SUCCEEDED", provider: "mock", queuedAt: hoursAgo(26), completedAt: hoursAgo(26), failureClass: null, failureDetailSafe: null, attemptCount: 1, observationId: "obs-2", questionId: "q-sf" },
    { id: "run-3", status: "SUCCEEDED", provider: "9router", queuedAt: hoursAgo(50), completedAt: hoursAgo(50), failureClass: null, failureDetailSafe: null, attemptCount: 1, observationId: "obs-3", questionId: "q-price" },
    { id: "run-4", status: "FAILED", provider: "mock", queuedAt: hoursAgo(80), completedAt: hoursAgo(80), failureClass: "PROVIDER_TIMEOUT", failureDetailSafe: "Provider did not respond within 30s", attemptCount: 3, observationId: null, questionId: "q-cancel" },
  ],
  "biz-harbor": [
    { id: "run-h1", status: "SUCCEEDED", provider: "mock", queuedAt: hoursAgo(10), completedAt: hoursAgo(10), failureClass: null, failureDetailSafe: null, attemptCount: 1, observationId: "obs-h1", questionId: "q-beans" },
  ],
}

export type MockObservation = { observation: Observation; claims: Claim[] }

export const mockObservations: Record<string, MockObservation> = {
  "obs-1": {
    observation: { id: "obs-1", business_id: "biz-northstar", answer_text: "Northstar costs $29 per month and includes a Salesforce integration. You can cancel anytime with 30 days notice.", provider: "mock", observed_model: "mock-1.0", collected_at: hoursAgo(3), retrieval_mode: "live", raw_text: null },
    claims: [
      { id: "claim-1", text: "Northstar costs $29 per month." },
      { id: "claim-2", text: "Northstar includes a Salesforce integration." },
      { id: "claim-3", text: "You can cancel with 30 days notice." },
    ],
  },
  "obs-2": {
    observation: { id: "obs-2", business_id: "biz-northstar", answer_text: "Yes — Northstar integrates natively with Salesforce, syncing contacts in real time. Plans start at $39 per month.", provider: "mock", observed_model: "mock-1.0", collected_at: hoursAgo(26), retrieval_mode: "live", raw_text: null },
    claims: [{ id: "claim-4", text: "Northstar integrates natively with Salesforce." }],
  },
  "obs-3": {
    observation: { id: "obs-3", business_id: "biz-northstar", answer_text: "Northstar's starter plan is $39 per month with a 14-day free trial. There is no native Salesforce integration on the starter plan.", provider: "9router", observed_model: "live-model", collected_at: hoursAgo(50), retrieval_mode: "live", raw_text: null },
    claims: [{ id: "claim-5", text: "Northstar starter plan is $39 per month with a 14-day free trial." }],
  },
  "obs-h1": {
    observation: { id: "obs-h1", business_id: "biz-harbor", answer_text: "Harbor's single origin bag is $22, with free shipping over $35.", provider: "mock", observed_model: "mock-1.0", collected_at: hoursAgo(10), retrieval_mode: "live", raw_text: null },
    claims: [{ id: "claim-h1", text: "Harbor's single origin bag is $22." }],
  },
}

export const mockIssues: Record<string, Issue[]> = {
  "biz-northstar": [
    { claim_id: "claim-1", claim_text: "Northstar costs $29 per month.", state: "WRONG", verdict: "CONTRADICTED", notes: "Approved price is $39 since Jan.", answer_text: "Northstar costs $29 per month and includes a Salesforce integration.", provider: "mock", observed_model: "mock-1.0", question_prompt: "How much does Northstar cost?", facts: [{ id: "fact-price", predicate: "monthly_price", valueText: "$39", status: "ACTIVE" }], observation_id: "obs-1", collected_at: hoursAgo(3) },
    { claim_id: "claim-2", claim_text: "Northstar includes a Salesforce integration.", state: "WRONG", verdict: "CONTRADICTED", notes: null, answer_text: "Northstar costs $29 per month and includes a Salesforce integration.", provider: "mock", observed_model: "mock-1.0", question_prompt: "Does Northstar integrate with Salesforce?", facts: [{ id: "fact-sf", predicate: "salesforce_integration", valueText: "false", status: "ACTIVE" }], observation_id: "obs-1", collected_at: hoursAgo(3) },
    { claim_id: "claim-3", claim_text: "You can cancel with 30 days notice.", state: "PARTIAL", verdict: "PARTIAL", notes: "Cancellation is 24 hours, not 30 days.", answer_text: "You can cancel anytime with 30 days notice.", provider: "mock", observed_model: "mock-1.0", question_prompt: "What is Northstar's cancellation policy?", facts: [{ id: "fact-cancel", predicate: "cancellation_period", valueText: "24 hours", status: "ACTIVE" }], observation_id: "obs-1", collected_at: hoursAgo(3) },
    { claim_id: "claim-4", claim_text: "Northstar integrates natively with Salesforce.", state: "NEEDS_REVIEW", verdict: null, notes: null, answer_text: "Yes — Northstar integrates natively with Salesforce.", provider: "mock", observed_model: "mock-1.0", question_prompt: "Does Northstar integrate with Salesforce?", facts: [], observation_id: "obs-2", collected_at: hoursAgo(26) },
    { claim_id: "claim-5", claim_text: "Northstar starter plan is $39 per month with a 14-day free trial.", state: "UNKNOWN", verdict: "INSUFFICIENT_EVIDENCE", notes: null, answer_text: "Northstar's starter plan is $39 per month with a 14-day free trial.", provider: "9router", observed_model: "live-model", question_prompt: "How much does Northstar cost?", facts: [{ id: "fact-price", predicate: "monthly_price", valueText: "$39", status: "ACTIVE" }, { id: "fact-trial", predicate: "free_trial", valueText: "14 days", status: "ACTIVE" }], observation_id: "obs-3", collected_at: hoursAgo(50) },
  ],
  "biz-harbor": [
    { claim_id: "claim-h1", claim_text: "Harbor's single origin bag is $22.", state: "NEEDS_REVIEW", verdict: null, notes: null, answer_text: "Harbor's single origin bag is $22, with free shipping over $35.", provider: "mock", observed_model: "mock-1.0", question_prompt: "How much is Harbor's single origin bag?", facts: [], observation_id: "obs-h1", collected_at: hoursAgo(10) },
  ],
}

export const mockOverviews: Record<string, Overview> = {
  "biz-northstar": { completed: "18", last_checked: hoursAgo(3), unreviewed: "2", needs_attention: "3" },
  "biz-harbor": { completed: "4", last_checked: hoursAgo(10), unreviewed: "1", needs_attention: "0" },
}

export function mockAnalytics(businessId: string, days: number): Analytics {
  const seed = businessId === "biz-harbor" ? 2 : 5
  const daily = Array.from({ length: Math.min(days, 30) }, (_, i) => {
    const d = Math.min(days, 30) - 1 - i
    const wrong = (d * 7 + seed) % 4
    const partial = (d * 3 + seed) % 3
    const unknown = d % 2
    const unreviewed = (d + seed) % 3
    const supported = 4 + ((d + seed) % 5)
    const failed = d % 5 === 0 ? 1 : 0
    const checks = 2 + ((d + seed) % 3)
    return { date: ymd(d), supported, wrong, partial, unknown, unreviewed, checks, failed }
  })
  const sum = (k: "supported" | "wrong" | "partial" | "unknown" | "unreviewed" | "checks" | "failed") =>
    daily.reduce((n, d) => n + (d[k] as number), 0)
  const answers = sum("checks") - sum("failed")
  const current = { supported: sum("supported"), wrong: sum("wrong"), partial: sum("partial"), unknown: sum("unknown"), unreviewed: sum("unreviewed"), checks: sum("checks"), answers, failed: sum("failed") }
  const previous = { supported: current.supported - 3, wrong: current.wrong + 1, partial: current.partial, unknown: current.unknown, unreviewed: current.unreviewed + 2, checks: current.checks - 2, answers: answers - 2 }
  const qs = (mockQuestions[businessId] ?? []).map((q, i) => ({
    id: q.id, prompt: q.prompt, label: q.label, checks: 4 - (i % 2), last_checked_at: hoursAgo(i * 20 + 3),
    supported: 3 - i, wrong: 1 + (i % 2), partial: i % 2, unknown: 0, unreviewed: 1,
  }))
  const fs = (mockFacts[businessId] ?? []).filter((f) => f.status === "ACTIVE").slice(0, 4).map((f, i) => ({
    id: f.id, predicate: f.predicate, value_text: f.valueText, status: f.status,
    supported: 2, wrong: 2 - (i % 2), partial: i % 2, unknown: 0, unreviewed: 1,
  }))
  return {
    range: { days, from: ymd(days), to: ymd(0) },
    current, previous, daily,
    providers: [
      { provider: "mock", answers: Math.max(answers - 2, 1), supported: current.supported - 1, wrong: current.wrong - 1, partial: current.partial, unknown: current.unknown, unreviewed: current.unreviewed },
      { provider: "9router", answers: 2, supported: 1, wrong: 1, partial: 0, unknown: 0, unreviewed: 0 },
    ],
    questions: qs,
    facts: fs,
  }
}

// --- mutations (in-memory, enough to click through the UI) ---
let n = 100
const nid = (p: string) => `${p}-mock-${++n}`

export function mockAddBusiness(name: string): Business {
  const b = { id: nid("biz"), name }
  mockBusinesses.push(b)
  mockFacts[b.id] = []
  mockQuestions[b.id] = []
  mockCheckRuns[b.id] = []
  mockIssues[b.id] = []
  mockOverviews[b.id] = { completed: "0", last_checked: null, unreviewed: "0", needs_attention: "0" }
  return b
}

export function mockAddFact(businessId: string, input: Record<string, unknown>): Fact {
  const f: Fact = {
    id: nid("fact"), subject: String(input["subject"] ?? ""), predicate: String(input["predicate"] ?? ""),
    valueText: String(input["valueText"] ?? ""), valueType: String(input["valueType"] ?? "TEXT"),
    status: "ACTIVE", version: 1, validFrom: daysAgo(0), validUntil: null,
  }
  mockFacts[businessId] = [...(mockFacts[businessId] ?? []), f]
  return f
}

export function mockAddQuestion(businessId: string, input: { prompt: string; label: string | null; origin: string }): Question {
  const q: Question = { id: nid("q"), prompt: input.prompt, label: input.label, origin: input.origin }
  mockQuestions[businessId] = [...(mockQuestions[businessId] ?? []), q]
  return q
}

export function mockQueueCheck(businessId: string, questionId: string, provider: string): CheckRun {
  const q = (mockQuestions[businessId] ?? []).find((x) => x.id === questionId)
  const obsId = nid("obs")
  const run: CheckRun = { id: nid("run"), status: "SUCCEEDED", provider, queuedAt: iso(new Date()), completedAt: iso(new Date()), failureClass: null, failureDetailSafe: null, attemptCount: 1, observationId: obsId, questionId }
  mockCheckRuns[businessId] = [run, ...(mockCheckRuns[businessId] ?? [])]
  mockObservations[obsId] = {
    observation: { id: obsId, business_id: businessId, answer_text: `Mock answer for "${q?.prompt ?? "your question"}": pricing starts at $39 per month with a 14-day free trial.`, provider, observed_model: "mock-1.0", collected_at: iso(new Date()), retrieval_mode: "live", raw_text: null },
    claims: [],
  }
  return run
}

export function mockAddClaim(observationId: string, text: string): { id: string } {
  const c = { id: nid("claim"), text }
  const entry = mockObservations[observationId]
  if (entry) entry.claims = [...entry.claims, c]
  const biz = entry?.observation.business_id
  if (biz) {
    mockIssues[biz] = [{ claim_id: c.id, claim_text: text, state: "NEEDS_REVIEW", verdict: null, notes: null, answer_text: entry.observation.answer_text, provider: entry.observation.provider, observed_model: entry.observation.observed_model, question_prompt: null, facts: [], observation_id: observationId, collected_at: iso(new Date()) }, ...(mockIssues[biz] ?? [])]
  }
  return { id: c.id }
}
