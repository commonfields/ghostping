// Client record API: operator workflow (session) and the public record.
// Shapes mirror packages/db record.ts / record-view.ts JSON.
import { api } from "./api"

export type Decision = "MATCHES" | "CONTRADICTS" | "UNKNOWN"
export type Outcome = "OBSERVED_CORRECTION" | "NO_OBSERVED_CHANGE" | "INDETERMINATE"
export type RunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED"
export type ValueType = "TEXT" | "NUMBER" | "CURRENCY" | "BOOLEAN" | "DATE" | "URL" | "ENUM"
export type Engagement = "CLIENT" | "DOGFOOD" | "FIXTURE"

export type ClientSummary = { businessId: string; name: string; websiteUrl: string; engagement: Engagement; createdAt: string; hasActiveShare: boolean; lastCheckedAt: string | null }

export type RecordItem = {
  id: string
  slot: 1 | 2 | 3
  supersedesId: string | null
  superseded: boolean
  createdAt: string
  sourceUrl: string
  approval: { approvedAt: string; approvedByUserId: string } | null
  fact: { id: string; subject: string; predicate: string; valueText: string; valueType: ValueType; version: number; status: string; validFrom: string; validUntil: string | null }
  question: { id: string; prompt: string }
}
export type Judgment = { id: string; decision: Decision; note: string | null; supersedesId: string | null; reviewedByUserId: string; reviewedAt: string }
export type RecordObservation = {
  id: string
  provider: string
  requestedModel: string | null
  observedModel: string | null
  modelVersion: string | null
  collectedAt: string
  answerText: string
  retrievalMode: string
  retrievalTool: string | null
  rawDigest: string
  synthetic: boolean
  citations: Array<{ uri: string | null; title: string | null; position: number | null }>
  providerMetadata: unknown
}
export type RecordCheck = {
  id: string
  runId: string
  itemId: string
  questionId: string
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED"
  failureClass: string | null
  failureDetailSafe: string | null
  queuedAt: string
  completedAt: string | null
  observation: RecordObservation | null
  judgments: Judgment[]
  judgment: Judgment | null
  retrievalRequested: boolean | null
  retrievalObserved: boolean | null
  surface: string | null
}
export type RecordRun = { id: string; kind: "INITIAL" | "FOLLOW_UP"; baselineRunId: string | null; provider: string; requestedModel: string | null; createdAt: string; status: RunStatus; checks: RecordCheck[] }
export type RecordAction = { id: string; slot: number | null; type: string; note: string | null; links: string[]; performedAt: string; createdAt: string }
export type Comparison =
  | { state: "PENDING_CHECK" }
  | { state: "AWAITING_REVIEW" }
  | { state: "DERIVED"; outcome: Outcome; reason: string | null; text: string }
export type OperatorRecord = {
  profile: { businessId: string; name: string; websiteUrl: string; engagement: Engagement; createdAt: string }
  slots: Array<{ slot: 1 | 2 | 3; item: RecordItem; history: RecordItem[]; baselineCheckId: string | null; latestFollowUpCheckId: string | null; comparison: Comparison | null; actions: RecordAction[] }>
  runs: RecordRun[]
  actions: RecordAction[]
  share: { id: string; publicId: string; status: "ACTIVE" | "REVOKED"; createdAt: string; revokedAt: string | null } | null
  disclosure: string
  activeRun: boolean
}
export type RecordResponse = { record: OperatorRecord; surface: { provider: string; model: string } }

export type SlotInput = { subject: string; predicate: string; valueText: string; valueType: ValueType; sourceUrl: string; question: string; validFrom?: string; validUntil?: string | null }
export type ActionInput = { slot: 1 | 2 | 3 | null; note: string; links: string[]; performedAt?: string }

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })
const base = (id: string) => `/api/record/clients/${encodeURIComponent(id)}`

export const Records = {
  list: () => api<{ clients: ClientSummary[] }>("/api/record/clients"),
  create: (input: { name: string; websiteUrl: string; engagement?: Engagement }) =>
    api<{ client: { businessId: string } }>("/api/record/clients", { method: "POST", ...json(input) }),
  get: (id: string) => api<RecordResponse>(base(id)),
  update: (id: string, input: { name: string; websiteUrl: string }) => api<RecordResponse>(base(id), { method: "PUT", ...json(input) }),
  saveSlot: (id: string, slot: number, input: SlotInput) => api<{ item: RecordItem }>(`${base(id)}/slots/${slot}`, { method: "PUT", ...json(input) }),
  approve: (id: string, itemId: string) => api<RecordResponse>(`${base(id)}/items/${encodeURIComponent(itemId)}/approve`, { method: "POST" }),
  run: (id: string, kind?: "INITIAL" | "FOLLOW_UP") => api<{ run: { id: string; kind: string } }>(`${base(id)}/runs`, { method: "POST", ...json(kind ? { kind } : {}) }),
  judge: (id: string, observationId: string, decision: Decision, note: string | null) =>
    api<{ judgment: Judgment }>(`${base(id)}/judgments`, { method: "POST", ...json({ observationId, decision, note }) }),
  action: (id: string, input: ActionInput) => api<{ action: RecordAction }>(`${base(id)}/actions`, { method: "POST", ...json(input) }),
  share: (id: string) => api<{ share: { publicId: string } }>(`${base(id)}/share`, { method: "POST" }),
  revoke: (id: string) => api<{ revoked: true }>(`${base(id)}/share/revoke`, { method: "POST" }),
}

// ---- public record (no session) ----

export type PublicAnswer = { question: string; fact: { label: string; value: string } } & (
  | { status: "CHECK_FAILED"; checkedAt: string | null; explanation: string }
  | {
    status: "ANSWERED"
    checkedAt: string
    surface: string
    model: string | null
    retrieval: { requested: boolean; observed: boolean; tool: string | null }
    syntheticFixture: boolean
    answer: string
    searchSuggestionsHtml: string | null
    citations: Array<{ url: string | null; title: string | null }>
    evidenceDigest: string
    judgment: { decision: Decision; label: string; reviewedAt: string; reviewedBy: string }
  })
export type PublicAction = { performedAt: string; note: string | null; links: string[] }
export type PublicFact = {
  position: number
  fact: { label: string; subject: string; value: string; source: string | null; approvedAt: string }
  question: string
  latest: PublicAnswer | null
  comparison: { before: PublicAnswer | null; actions: PublicAction[]; after: PublicAnswer; outcome: Outcome; explanation: string } | null
  pendingActions: PublicAction[]
}
export type PublicRecord = {
  client: { name: string; website: string | null }
  checkedBy: string
  fixture: boolean
  lastCheckedAt: string | null
  surface: { name: string; model: string | null; retrievalTool: string | null } | null
  facts: PublicFact[]
  disclosure: string
}

export const publicRecordPath = (publicId: string) => `/open/${publicId}`
export const safeRecordUrl = (value: string | null): string | null => {
  if (!value) return null
  try { const u = new URL(value); return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.toString() : null } catch { return null }
}
export const fetchPublicRecord = async (publicId: string): Promise<PublicRecord | null> => {
  const res = await fetch(`/api/public/records/${encodeURIComponent(publicId)}`, { credentials: "omit", referrerPolicy: "no-referrer" })
  if (res.status === 404) return null
  if (!res.ok) throw new Error("This record is temporarily unavailable.")
  return ((await res.json()) as { record: PublicRecord }).record
}

export const OUTCOME_LABELS: Record<Outcome, string> = {
  OBSERVED_CORRECTION: "Observed correction",
  NO_OBSERVED_CHANGE: "No observed change",
  INDETERMINATE: "Indeterminate",
}
export const DECISION_LABELS: Record<Decision, string> = { MATCHES: "Matches", CONTRADICTS: "Contradicts", UNKNOWN: "Unknown" }
export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  QUEUED: "Queued", RUNNING: "Running", SUCCEEDED: "Succeeded", PARTIALLY_SUCCEEDED: "Partially succeeded", FAILED: "Failed",
}
