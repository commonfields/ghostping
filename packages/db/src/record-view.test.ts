// Pure record derivation: comparison rules, run status, judgment heads and
// the public allowlist. Rows are hand-built TEST fixtures.
import { describe, expect, it } from "vitest"
import { hostedMeasurementContext } from "./evidence.js"
import { compareSlot, currentJudgment, publicRecord, runStatus, type SlotEvidence } from "./record-view.js"
import type { RecordCheck, RecordItem, RecordJudgment, RecordObservation, RecordSnapshot } from "./record.js"

const BIZ = "00000000-0000-4000-8000-000000000001"
const item = (over: Partial<RecordItem> = {}): RecordItem => ({
  id: "00000000-0000-4000-8000-0000000000a1", slot: 1, supersedesId: null, superseded: false, createdAt: "2026-10-01T00:00:00.000Z",
  sourceUrl: "https://client.test/rooms", approval: { approvedAt: "2026-10-01T00:00:00.000Z", approvedByUserId: "00000000-0000-4000-8000-0000000000u1" },
  fact: { id: "00000000-0000-4000-8000-0000000000f1", subject: "TEST Hotel", predicate: "Breakfast included", valueText: "Yes", valueType: "TEXT",
    version: 1, status: "ACTIVE", validFrom: "2026-01-01T00:00:00.000Z", validUntil: null },
  question: { id: "00000000-0000-4000-8000-0000000000q1", prompt: "Is breakfast included at TEST Hotel?" },
  ...over,
})
let seq = 0
const observation = (at: string, over: Partial<RecordObservation> = {}, model = "gemini-2.5-flash"): RecordObservation => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, provider: "gemini", requestedModel: "gemini-2.5-flash", observedModel: model,
  modelVersion: model, collectedAt: at, answerText: "Breakfast costs €20.", retrievalMode: "PROVIDER_GROUNDING", retrievalTool: "google_search",
  requestParameters: { model: "gemini-2.5-flash", tools: ["google_search"] }, rawDigest: "a".repeat(64), synthetic: false,
  measurementContext: hostedMeasurementContext({ businessId: BIZ, questionId: item().question.id, checkRunId: `run-${seq}`, prompt: item().question.prompt,
    provider: "gemini", requestedModel: "gemini-2.5-flash", observedModel: model, observedAt: at }),
  providerMetadata: { responseId: "internal-response-id" }, citations: [{ uri: "https://source.test/a", title: "source.test", position: 1 }],
  ...over,
})
const judgment = (decision: RecordJudgment["decision"], over: Partial<RecordJudgment> = {}): RecordJudgment => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, decision, note: "TEST internal note", supersedesId: null,
  reviewedByUserId: "00000000-0000-4000-8000-0000000000u1", reviewedAt: "2026-10-02T00:00:00.000Z", ...over,
})
const check = (obs: RecordObservation | null, status: RecordCheck["status"] = obs ? "SUCCEEDED" : "FAILED", judgments: RecordJudgment[] = [], over: Partial<RecordCheck> = {}): RecordCheck => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, runId: "r", itemId: item().id, questionId: item().question.id, status,
  failureClass: status === "FAILED" ? "PROVIDER_UNAVAILABLE" : null, failureDetailSafe: status === "FAILED" ? "provider unavailable" : null,
  queuedAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:00:00.000Z", observation: obs, judgments, ...over,
})
const ev = (c: RecordCheck, it: RecordItem = item()): SlotEvidence => ({ check: c, item: it, judgment: currentJudgment(c.judgments) })
const T1 = "2026-10-01T10:00:00.000Z"
const T2 = "2026-10-08T10:00:00.000Z"
const pair = (b: RecordJudgment["decision"], a: RecordJudgment["decision"]) =>
  compareSlot(ev(check(observation(T1), "SUCCEEDED", [judgment(b)])), ev(check(observation(T2), "SUCCEEDED", [judgment(a)])))

describe("record comparison rules", () => {
  it("derives the three outcomes from reviewed judgments", () => {
    expect(pair("CONTRADICTS", "MATCHES")).toEqual({ state: "DERIVED", outcome: "OBSERVED_CORRECTION", reason: null })
    expect(pair("CONTRADICTS", "CONTRADICTS")).toEqual({ state: "DERIVED", outcome: "NO_OBSERVED_CHANGE", reason: null })
    expect(pair("MATCHES", "MATCHES")).toEqual({ state: "DERIVED", outcome: "NO_OBSERVED_CHANGE", reason: null })
    expect(pair("CONTRADICTS", "UNKNOWN")).toMatchObject({ outcome: "INDETERMINATE", reason: "AFTER_UNKNOWN" })
    expect(pair("UNKNOWN", "MATCHES")).toMatchObject({ outcome: "INDETERMINATE", reason: "BEFORE_UNKNOWN" })
    // A regression is not "no change" and not a correction.
    expect(pair("MATCHES", "CONTRADICTS")).toMatchObject({ outcome: "INDETERMINATE", reason: "ANSWER_NO_LONGER_MATCHES" })
  })
  it("never derives an outcome from unfinished or unreviewed work", () => {
    const reviewed = ev(check(observation(T1), "SUCCEEDED", [judgment("CONTRADICTS")]))
    expect(compareSlot(reviewed, ev(check(null, "RUNNING")))).toEqual({ state: "PENDING_CHECK" })
    expect(compareSlot(reviewed, ev(check(null, "QUEUED")))).toEqual({ state: "PENDING_CHECK" })
    expect(compareSlot(reviewed, ev(check(observation(T2))))).toEqual({ state: "AWAITING_REVIEW" })
    expect(compareSlot(ev(check(observation(T1))), ev(check(observation(T2), "SUCCEEDED", [judgment("MATCHES")])))).toEqual({ state: "AWAITING_REVIEW" })
  })
  it("names why a comparison is INDETERMINATE", () => {
    const before = (o = observation(T1), j = [judgment("CONTRADICTS")]) => ev(check(o, "SUCCEEDED", j))
    const after = (o = observation(T2), j = [judgment("MATCHES")], it = item()) => ev(check(o, "SUCCEEDED", j), it)
    const reason = (b: SlotEvidence | null, a: SlotEvidence) => { const r = compareSlot(b, a); return r.state === "DERIVED" ? r.reason : r.state }
    expect(reason(null, after())).toBe("NO_BASELINE")
    expect(reason(ev(check(null, "FAILED")), after())).toBe("BEFORE_CHECK_FAILED")
    expect(reason(before(), ev(check(null, "FAILED")))).toBe("AFTER_CHECK_FAILED")
    expect(reason(before(), after(undefined, undefined, item({ fact: { ...item().fact, id: "00000000-0000-4000-8000-0000000000f2" } })))).toBe("FACT_CHANGED")
    expect(reason(before(), ev(check(observation(T2), "SUCCEEDED", [judgment("MATCHES")], { questionId: "00000000-0000-4000-8000-0000000000q2" })))).toBe("QUESTION_CHANGED")
    expect(reason(before(observation(T1, { synthetic: true })), after())).toBe("SYNTHETIC_EVIDENCE")
    expect(reason(before(observation(T1, { retrievalMode: "NONE" })), after())).toBe("BEFORE_NO_RETRIEVAL")
    expect(reason(before(), after(observation(T2, { retrievalMode: "NONE" })))).toBe("AFTER_NO_RETRIEVAL")
    expect(reason(before(), after(observation(T2, { retrievalMode: "unknown" })))).toBe("AFTER_NO_RETRIEVAL")
    expect(reason(before(), after(observation(T2, {}, "gemini-2.5-pro")))).toBe("SURFACE_CHANGED")
    expect(reason(before(observation(T1, { measurementContext: null })), after())).toBe("SURFACE_UNKNOWN")
    expect(reason(before(observation(T2)), after(observation(T1)))).toBe("OUT_OF_ORDER")
  })
  it("a forked or empty judgment chain has no current judgment", () => {
    const root = judgment("CONTRADICTS")
    expect(currentJudgment([])).toBeNull()
    expect(currentJudgment([root, judgment("MATCHES", { supersedesId: root.id })])!.decision).toBe("MATCHES")
    expect(currentJudgment([root, judgment("MATCHES", { supersedesId: root.id }), judgment("UNKNOWN", { supersedesId: root.id })])).toBeNull()
  })
  it("run status never turns partial evidence into success", () => {
    const ok = check(observation(T1))
    expect(runStatus([ok, ok])).toBe("SUCCEEDED")
    expect(runStatus([ok, check(null, "FAILED")])).toBe("PARTIALLY_SUCCEEDED")
    expect(runStatus([check(null, "FAILED")])).toBe("FAILED")
    expect(runStatus([ok, check(null, "RUNNING")])).toBe("RUNNING")
    expect(runStatus([check(null, "QUEUED")])).toBe("QUEUED")
    expect(runStatus([])).toBe("FAILED")
  })
})

describe("public projection allowlist", () => {
  const snapshot = (checks: RecordCheck[]): RecordSnapshot => ({
    profile: { businessId: BIZ, name: "TEST Hotel", websiteUrl: "https://client.test/", engagement: "CLIENT", createdAt: T1 },
    items: [item()], runs: [{ id: "r", kind: "INITIAL", baselineRunId: null, provider: "gemini", requestedModel: "gemini-2.5-flash", retrievalRequired: true, createdAt: T1 }],
    checks, actions: [{ id: "00000000-0000-4000-8000-0000000000c1", slot: null, type: "SOURCE_UPDATED", note: "Updated /rooms", links: ["javascript:alert(1)", "https://client.test/rooms"],
      performedAt: T2, actorId: "00000000-0000-4000-8000-0000000000u1", createdAt: T2 }],
    share: { id: "00000000-0000-4000-8000-0000000000s1", publicId: "x".repeat(43), status: "ACTIVE", createdAt: T1, revokedAt: null },
  })
  it("keeps drafts private and drops unsafe links, ids, notes and provider internals", () => {
    expect(publicRecord(snapshot([check(observation(T1))])).facts[0]!.latest).toBeNull()
    const o = observation(T1, { citations: [{ uri: "javascript:alert(1)", title: "evil" }, { uri: "data:text/html,x", title: null }, { uri: "https://ok.test/", title: "ok" }].map((c, i) => ({ ...c, position: i })) })
    const page = publicRecord(snapshot([check(o, "SUCCEEDED", [judgment("CONTRADICTS")])]))
    const latest = page.facts[0]!.latest!
    expect(latest.status === "ANSWERED" && latest.citations).toEqual([{ url: null, title: "evil" }, { url: "https://ok.test/", title: "ok" }])
    expect(page.facts[0]!.pendingActions).toEqual([{ performedAt: T2, note: "Updated /rooms", links: ["https://client.test/rooms"] }])
    const text = JSON.stringify(page)
    for (const hidden of [BIZ, "TEST internal note", "internal-response-id", "x".repeat(43), o.id, item().id, item().fact.id, "00000000-0000-4000-8000-0000000000u1", "javascript:"]) {
      expect(text).not.toContain(hidden)
    }
  })
})
