// Client record read model. Everything is derived from the stored evidence
// on each request: run status, the before/after comparison per fact, and
// what the public page may show. Nothing here writes or caches a verdict.
//
// Wording rule: statements are never stronger than the evidence. The record
// reports what was observed before and after; it never says an action
// caused an answer (CAUSALITY_DISCLOSURE is shown with every comparison).
import { Schema } from "effect"
import { compareMeasurements, measurementSignature, MeasurementContextV1 } from "@openrecord/protocol"
import type { RecordAction, RecordCheck, RecordDecision, RecordItem, RecordJudgment, RecordObservation, RecordRun, RecordSnapshot } from "./record.js"

export const CAUSALITY_DISCLOSURE =
  "This shows what OpenRecord observed before and after the change. It does not prove that the edit caused the model's new answer."

export type RecordRunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED"
export type RecordOutcome = "OBSERVED_CORRECTION" | "NO_OBSERVED_CHANGE" | "INDETERMINATE"
export type IndeterminateReason =
  | "NO_BASELINE" | "BEFORE_CHECK_FAILED" | "AFTER_CHECK_FAILED" | "FACT_CHANGED" | "QUESTION_CHANGED" | "SYNTHETIC_EVIDENCE"
  | "BEFORE_NO_RETRIEVAL" | "AFTER_NO_RETRIEVAL" | "SURFACE_CHANGED" | "SURFACE_UNKNOWN" | "OUT_OF_ORDER"
  | "BEFORE_UNKNOWN" | "AFTER_UNKNOWN" | "ANSWER_NO_LONGER_MATCHES"

/** Retrieval modes that mean the provider reported actually using live web results. */
const RETRIEVAL_OBSERVED = new Set(["PROVIDER_GROUNDING", "WEB_SEARCH", "grounded"])
export const retrievalObserved = (o: RecordObservation): boolean => RETRIEVAL_OBSERVED.has(o.retrievalMode)
export const retrievalRequested = (o: RecordObservation): boolean => {
  const tools = (o.requestParameters as { tools?: unknown } | null)?.tools
  return Array.isArray(tools) && tools.length > 0
}

export const runStatus = (checks: ReadonlyArray<RecordCheck>): RecordRunStatus => {
  if (checks.length === 0) return "FAILED"
  if (checks.some(c => c.status === "QUEUED" || c.status === "RUNNING")) return checks.every(c => c.status === "QUEUED") ? "QUEUED" : "RUNNING"
  const ok = checks.filter(c => c.status === "SUCCEEDED").length
  return ok === checks.length ? "SUCCEEDED" : ok === 0 ? "FAILED" : "PARTIALLY_SUCCEEDED"
}

/** Current judgment: the head of the append-only correction chain. */
export const currentJudgment = (chain: ReadonlyArray<RecordJudgment>): RecordJudgment | null => {
  const superseded = new Set(chain.flatMap(j => (j.supersedesId === null ? [] : [j.supersedesId])))
  const heads = chain.filter(j => !superseded.has(j.id))
  return heads.length === 1 ? heads[0]! : null
}

export interface SlotEvidence { readonly check: RecordCheck; readonly item: RecordItem; readonly judgment: RecordJudgment | null }
export type SlotComparison =
  | { readonly state: "PENDING_CHECK" }
  | { readonly state: "AWAITING_REVIEW" }
  | { readonly state: "DERIVED"; readonly outcome: RecordOutcome; readonly reason: IndeterminateReason | null }

const decodeContext = Schema.decodeUnknownEither(MeasurementContextV1)
const indeterminate = (reason: IndeterminateReason): SlotComparison => ({ state: "DERIVED", outcome: "INDETERMINATE", reason })

/**
 * One fact, one earlier answer, one later answer. OBSERVED_CORRECTION needs
 * a reviewed CONTRADICTS followed by a reviewed MATCHES, both retrieval-backed
 * live answers from a comparable surface for the same fact and question.
 * Anything weaker is INDETERMINATE with its reason; never hidden.
 */
export const compareSlot = (before: SlotEvidence | null, after: SlotEvidence): SlotComparison => {
  if (after.check.status === "QUEUED" || after.check.status === "RUNNING") return { state: "PENDING_CHECK" }
  if (before === null) return indeterminate("NO_BASELINE")
  if (before.check.status !== "SUCCEEDED" || before.check.observation === null) return indeterminate("BEFORE_CHECK_FAILED")
  if (after.check.status !== "SUCCEEDED" || after.check.observation === null) return indeterminate("AFTER_CHECK_FAILED")
  if (before.judgment === null || after.judgment === null) return { state: "AWAITING_REVIEW" }
  const b = before.check.observation
  const a = after.check.observation
  if (before.item.fact.id !== after.item.fact.id) return indeterminate("FACT_CHANGED")
  if (before.check.questionId !== after.check.questionId) return indeterminate("QUESTION_CHANGED")
  if (b.synthetic || a.synthetic) return indeterminate("SYNTHETIC_EVIDENCE")
  if (!retrievalObserved(b)) return indeterminate("BEFORE_NO_RETRIEVAL")
  if (!retrievalObserved(a)) return indeterminate("AFTER_NO_RETRIEVAL")
  const bc = decodeContext(b.measurementContext)
  const ac = decodeContext(a.measurementContext)
  if (bc._tag === "Left" || ac._tag === "Left") return indeterminate("SURFACE_UNKNOWN")
  const match = compareMeasurements(measurementSignature(bc.right), measurementSignature(ac.right))
  if (match === "NOT_COMPARABLE") return indeterminate("SURFACE_CHANGED")
  if (match === "INDETERMINATE") return indeterminate("SURFACE_UNKNOWN")
  if (Date.parse(a.collectedAt) <= Date.parse(b.collectedAt)) return indeterminate("OUT_OF_ORDER")
  const was: RecordDecision = before.judgment.decision
  const now: RecordDecision = after.judgment.decision
  if (was === "UNKNOWN") return indeterminate("BEFORE_UNKNOWN")
  if (now === "UNKNOWN") return indeterminate("AFTER_UNKNOWN")
  if (was === "CONTRADICTS" && now === "MATCHES") return { state: "DERIVED", outcome: "OBSERVED_CORRECTION", reason: null }
  if (was === now) return { state: "DERIVED", outcome: "NO_OBSERVED_CHANGE", reason: null }
  return indeterminate("ANSWER_NO_LONGER_MATCHES")
}

const failureWords = (failureClass: string | null): string => {
  switch (failureClass) {
    case "PROVIDER_TIMEOUT": return "the AI provider timed out"
    case "PROVIDER_RATE_LIMITED": return "the AI provider was rate limited"
    case "PROVIDER_AUTH": return "the AI provider rejected OpenRecord's credentials"
    case "PROVIDER_UNAVAILABLE": return "the AI provider was unavailable"
    case "WORKER_LOST": return "the check was interrupted"
    default: return "the AI provider returned an error"
  }
}

export const reasonText = (reason: IndeterminateReason, after: SlotEvidence | null = null): string => {
  switch (reason) {
    case "NO_BASELINE": return "There is no earlier answer for this fact to compare against."
    case "BEFORE_CHECK_FAILED": return "The first check for this fact could not be completed, so there is no earlier answer to compare against."
    case "AFTER_CHECK_FAILED": return `The later check could not be completed (${failureWords(after?.check.failureClass ?? null)}), so there is no later answer to compare.`
    case "FACT_CHANGED": return "The approved fact changed between the two checks, so the answers are not compared."
    case "QUESTION_CHANGED": return "The question changed between the two checks, so the answers are not compared."
    case "SYNTHETIC_EVIDENCE": return "One of these answers is test data, not a live AI answer."
    case "BEFORE_NO_RETRIEVAL": return "Indeterminate — the earlier answer did not use live web retrieval."
    case "AFTER_NO_RETRIEVAL": return "Indeterminate — this answer did not use live web retrieval."
    case "SURFACE_CHANGED": return "The AI model or its settings changed between checks, so the answers are not directly comparable."
    case "SURFACE_UNKNOWN": return "OpenRecord could not confirm that both answers came from the same AI model and settings."
    case "OUT_OF_ORDER": return "The two answers were not recorded in order, so they are not compared."
    case "BEFORE_UNKNOWN": return "The earlier answer could not be judged against the approved fact."
    case "AFTER_UNKNOWN": return "The later answer could not be judged against the approved fact."
    case "ANSWER_NO_LONGER_MATCHES": return "The earlier answer matched the approved fact; the later answer contradicts it."
  }
}

export const outcomeText = (comparison: Extract<SlotComparison, { state: "DERIVED" }>, before: SlotEvidence | null, after: SlotEvidence): string => {
  if (comparison.outcome === "OBSERVED_CORRECTION") return "Observed correction. The earlier answer contradicted the approved fact; the later answer matches it."
  if (comparison.outcome === "NO_OBSERVED_CHANGE") {
    return before?.judgment?.decision === "MATCHES" ? "No observed change. Both answers match the approved fact." : "No observed change. Both answers contradict the approved fact."
  }
  return reasonText(comparison.reason!, after)
}

// ---------------------------------------------------------------------------
// Slot assembly shared by the operator view and the public projection
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini API",
  mock: "OpenRecord test fixture (not a live AI)",
  "9router": "9Router gateway",
}
export const surfaceLabel = (o: RecordObservation): string => PROVIDER_LABELS[o.provider] ?? o.provider
const RETRIEVAL_TOOL_LABELS: Record<string, string> = { google_search: "Google Search grounding" }

/** A check is visible to the client once it is final: failed, or reviewed. */
export const checkPublished = (check: RecordCheck): boolean =>
  check.status === "FAILED" || (check.status === "SUCCEEDED" && check.observation !== null && currentJudgment(check.judgments) !== null)

interface SlotTimeline {
  readonly slot: number
  readonly head: RecordItem
  readonly baseline: SlotEvidence | null
  /** Latest follow-up of the current baseline with a check for this slot. */
  readonly latestFollowUp: SlotEvidence | null
  /** Latest follow-up that is published (final), for the public page. */
  readonly publishedFollowUp: SlotEvidence | null
}

const timelines = (s: RecordSnapshot): SlotTimeline[] => {
  const itemById = new Map(s.items.map(i => [i.id, i]))
  const baselineRun = [...s.runs].reverse().find(r => r.kind === "INITIAL") ?? null
  const followUps = baselineRun === null ? [] : s.runs.filter(r => r.kind === "FOLLOW_UP" && r.baselineRunId === baselineRun.id)
  const evidence = (check: RecordCheck): SlotEvidence => ({ check, item: itemById.get(check.itemId)!, judgment: currentJudgment(check.judgments) })
  const checkFor = (run: RecordRun, slot: number) => s.checks.find(c => c.runId === run.id && itemById.get(c.itemId)?.slot === slot) ?? null
  const heads = s.items.filter(i => !i.superseded).sort((a, b) => a.slot - b.slot)
  return heads.map(head => {
    const base = baselineRun === null ? null : checkFor(baselineRun, head.slot)
    const ups = followUps.flatMap(r => { const c = checkFor(r, head.slot); return c === null ? [] : [c] })
    const latest = ups.at(-1) ?? null
    const published = [...ups].reverse().find(checkPublished) ?? null
    return { slot: head.slot, head, baseline: base === null ? null : evidence(base),
      latestFollowUp: latest === null ? null : evidence(latest), publishedFollowUp: published === null ? null : evidence(published) }
  })
}

const actionsBetween = (actions: ReadonlyArray<RecordAction>, slot: number, from: string | null, until: string | null) =>
  actions.filter(a => (a.slot === null || a.slot === slot)
    && (from === null || Date.parse(a.performedAt) >= Date.parse(from))
    && (until === null || Date.parse(a.performedAt) <= Date.parse(until)))

const checkedAt = (e: SlotEvidence | null): string | null => e?.check.observation?.collectedAt ?? e?.check.completedAt ?? null

// ---------------------------------------------------------------------------
// Operator view (session-scoped; full evidence, internal notes included)
// ---------------------------------------------------------------------------

export const operatorView = (s: RecordSnapshot) => {
  const runs = s.runs.map(run => {
    const checks = s.checks.filter(c => c.runId === run.id)
    return { ...run, status: runStatus(checks), checks: checks.map(c => ({ ...c, judgment: currentJudgment(c.judgments),
      retrievalRequested: c.observation ? retrievalRequested(c.observation) : null, retrievalObserved: c.observation ? retrievalObserved(c.observation) : null,
      surface: c.observation ? surfaceLabel(c.observation) : null })) }
  })
  const slots = timelines(s).map(t => {
    const comparison = t.latestFollowUp === null ? null : compareSlot(t.baseline, t.latestFollowUp)
    return {
      slot: t.slot, item: t.head, history: s.items.filter(i => i.slot === t.slot),
      baselineCheckId: t.baseline?.check.id ?? null, latestFollowUpCheckId: t.latestFollowUp?.check.id ?? null,
      comparison: comparison === null ? null : comparison.state === "DERIVED"
        ? { ...comparison, text: outcomeText(comparison, t.baseline, t.latestFollowUp!) } : comparison,
      actions: actionsBetween(s.actions, t.slot, null, null),
    }
  })
  return { profile: s.profile, slots, runs, actions: s.actions, share: s.share, disclosure: CAUSALITY_DISCLOSURE,
    activeRun: runs.some(r => r.status === "QUEUED" || r.status === "RUNNING") }
}

// ---------------------------------------------------------------------------
// Public projection: an explicit allowlist. No database ids, account or user
// identities, internal review notes, raw provider payloads, or error detail.
// Unreviewed answers are drafts and stay private.
// ---------------------------------------------------------------------------

const httpUrl = (value: string | null): string | null => {
  if (value === null) return null
  try {
    const u = new URL(value)
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null
  } catch { return null }
}

const DECISION_COPY: Record<RecordDecision, string> = {
  MATCHES: "Matches the approved fact",
  CONTRADICTS: "Contradicts the approved fact",
  UNKNOWN: "Unknown — the answer could not be judged against the approved fact",
}

const publicAnswer = (e: SlotEvidence) => {
  const o = e.check.observation
  if (e.check.status !== "SUCCEEDED" || o === null) {
    return { status: "CHECK_FAILED" as const, checkedAt: checkedAt(e), explanation: `This check could not be completed: ${failureWords(e.check.failureClass)}.` }
  }
  const judgment = e.judgment!
  return {
    status: "ANSWERED" as const,
    checkedAt: o.collectedAt,
    surface: surfaceLabel(o),
    model: o.modelVersion ?? o.observedModel ?? o.requestedModel,
    retrieval: {
      requested: retrievalRequested(o),
      observed: retrievalObserved(o),
      tool: o.retrievalTool === null ? null : RETRIEVAL_TOOL_LABELS[o.retrievalTool] ?? o.retrievalTool,
    },
    syntheticFixture: o.synthetic,
    answer: o.answerText,
    citations: o.citations.flatMap(c => { const url = httpUrl(c.uri); return url === null && c.title === null ? [] : [{ url, title: c.title }] }),
    evidenceDigest: o.rawDigest,
    judgment: { decision: judgment.decision, label: DECISION_COPY[judgment.decision], reviewedAt: judgment.reviewedAt, reviewedBy: "Reviewed by the agency" },
  }
}

const publicAction = (a: RecordAction) => ({
  performedAt: a.performedAt,
  note: a.note,
  links: a.links.flatMap(l => { const url = httpUrl(l); return url === null ? [] : [url] }),
})

export const publicRecord = (s: RecordSnapshot) => {
  const facts = timelines(s).filter(t => t.head.approval !== null).map(t => {
    const after = t.publishedFollowUp
    // An unreviewed baseline keeps the comparison private (AWAITING_REVIEW)
    // rather than reading as "no earlier answer".
    const comparison = after === null ? null : compareSlot(t.baseline, after)
    const before = t.baseline !== null && checkPublished(t.baseline.check) ? t.baseline : null
    const latest = after !== null && comparison?.state === "DERIVED" ? after : before
    return {
      position: t.slot,
      fact: { label: t.head.fact.predicate, subject: t.head.fact.subject, value: t.head.fact.valueText,
        source: httpUrl(t.head.sourceUrl), approvedAt: t.head.approval!.approvedAt },
      question: t.head.question.prompt,
      latest: latest === null ? null : publicAnswer(latest),
      comparison: after === null || comparison === null || comparison.state !== "DERIVED" ? null : {
        before: before === null ? null : publicAnswer(before),
        actions: actionsBetween(s.actions, t.slot, checkedAt(before), checkedAt(after)).map(publicAction),
        after: publicAnswer(after),
        outcome: comparison.outcome,
        explanation: outcomeText(comparison, before, after),
      },
      // Actions recorded since the last published check, awaiting a re-check.
      pendingActions: latest === null ? [] : actionsBetween(s.actions, t.slot, checkedAt(latest), null).map(publicAction),
    }
  })
  const answered = facts.flatMap(f => (f.latest?.status === "ANSWERED" ? [f.latest] : []))
  const latestSurface = [...answered].sort((a, b) => a.checkedAt.localeCompare(b.checkedAt)).at(-1)
  const lastCheckedAt = latestSurface?.checkedAt ?? null
  return {
    client: { name: s.profile.name, website: httpUrl(s.profile.websiteUrl) },
    checkedBy: "OpenRecord",
    fixture: s.profile.engagement === "FIXTURE",
    lastCheckedAt,
    surface: latestSurface === undefined ? null : { name: latestSurface.surface, model: latestSurface.model, retrievalTool: latestSurface.retrieval.tool },
    facts,
    disclosure: CAUSALITY_DISCLOSURE,
  }
}
export type PublicRecord = ReturnType<typeof publicRecord>
