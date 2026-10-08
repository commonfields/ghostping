// Issue-loop read model: derivation rules asserted DB-free. Stubbed Effect
// layers cover tenancy; the pure builder covers UNKNOWN preservation,
// INDETERMINATE on unreviewed/ambiguous rechecks, MEASUREMENT_FAILED
// separation, and the protocol-only comparison rule.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { knownValue, PROTOCOL_VERSION, schemaId, surfaceForWorker } from "@openrecord/protocol"
import {
  BusinessRepository,
  CheckRunRepository,
  EvidenceLineageRepository,
  FactRepository,
  InterventionBindingRepository,
  ObservationRepository,
  ProductReadRepository,
  ReobservationIntentRepository,
  type CheckRunRow,
  type InterventionRow,
  type ReobservationIntentRow,
  type ReobservationRow,
} from "@openrecord/db"
import {
  buildIssueLoop,
  buildLoopComparison,
  deriveSourceVerification,
  loadIssueLoop,
  LOOP_DISPLAY_COPY,
  toLoopMeasurementContext,
  type LoopClaimInput,
  type LoopJudgmentInput,
  type LoopObservationInput,
} from "./issue-loop.js"

const BIZ = "11111111-1111-4111-8111-111111111111"
const QUESTION = "22222222-2222-4222-8222-222222222222"
const RUN_BEFORE = "33333333-3333-4333-8333-333333333333"
const RUN_AFTER = "44444444-4444-4444-8444-444444444444"
const OBS_BEFORE = "55555555-5555-4555-8555-555555555555"
const OBS_AFTER = "66666666-6666-4666-8666-666666666666"
const CLAIM = "77777777-7777-4777-8777-777777777777"
const AFTER_CLAIM = "88888888-8888-4888-8888-888888888888"
const AFTER_CLAIM_2 = "99999999-9999-4999-8999-999999999999"
const REOBS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const UNKNOWN_CLAIM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const PROMPT = "What is the starter price?"
const PROMPT_OTHER = "What is the team price?"

const ctx = (prompt: string, runId: string, provider: "mock" | "9router" = "mock") => ({
  schema: schemaId.measurement,
  schema_version: PROTOCOL_VERSION,
  question: prompt,
  question_id: QUESTION,
  question_version: knownValue("v-test"),
  business_id: BIZ,
  surface: surfaceForWorker(provider, "model-x", "model-x"),
  observed_at: "2026-10-01T10:00:00.000Z",
  measurement_configuration: knownValue({ deterministic_fixture: true }),
  sample_number: 1,
  repeat_id: knownValue(runId),
})

const obs = (
  id: string,
  answer: string,
  measurementContext: unknown,
  overrides?: { prompt?: string | null; collectedAt?: string },
): LoopObservationInput => ({
  id,
  businessId: BIZ,
  checkRunId: RUN_BEFORE,
  questionId: QUESTION,
  questionPrompt: overrides?.prompt === undefined ? PROMPT : overrides.prompt,
  provider: "mock",
  requestedModel: "model-x",
  observedModel: "model-x",
  collectedAt: overrides?.collectedAt ?? "2026-10-01T10:00:00.000Z",
  answerText: answer,
  citations: [],
  measurementContext,
})

const claim = (id: string, observationId: string, text = "Starter is $29 per month"): LoopClaimInput => ({
  id,
  observationId,
  text,
  createdAt: "2026-10-01T10:00:00.000Z",
})

const judgment = (id: string, claimId: string, verdict: string): LoopJudgmentInput => ({
  id,
  claimId,
  verdict,
  notes: null,
  supersedesId: null,
  createdAt: "2026-10-01T11:00:00.000Z",
})

const intervention = (n: string): InterventionRow => ({
  id: `c0000000-0000-4000-8000-0000000000${n}`,
  businessId: BIZ,
  issueIds: [CLAIM],
  type: "SOURCE_UPDATED",
  target: "https://acme.example/pricing",
  performedAt: "2026-10-02T00:00:00.000Z",
  actor: "HUMAN",
  actorId: null,
  notes: null,
  evidenceBeforeDigest: null,
  evidenceAfterDigest: null,
  supersedesId: null,
  correctionReason: null,
  createdAt: "2026-10-02T00:00:00.000Z",
})

const reobservation = (id: string, observationId: string): ReobservationRow => ({
  id,
  businessId: BIZ,
  originalObservationId: OBS_BEFORE,
  issueId: CLAIM,
  interventionId: null,
  observationId,
  createdAt: "2026-10-03T00:00:00.000Z",
})

const baseArgs = () => ({
  claim: claim(CLAIM, OBS_BEFORE),
  originalObservation: obs(OBS_BEFORE, "Starter is $29 per month", ctx(PROMPT, RUN_BEFORE)),
  claims: [claim(CLAIM, OBS_BEFORE)],
  judgments: [judgment("j1111111-1111-4111-8111-111111111111", CLAIM, "CONTRADICTED")],
  interventions: [] as InterventionRow[],
  reobservations: [] as ReobservationRow[],
  afterObservations: new Map<string, LoopObservationInput>(),
  relations: [],
  sourceBindings: [],
  sourceObservations: [],
  sourceValues: [],
  intents: [],
  checkRuns: new Map(),
  runObservations: new Map(),
})

describe("issue loop is derived, never stored", () => {
  const source = () => readFileSync(new URL("./issue-loop.ts", import.meta.url), "utf8")

  it("creates no tables and performs no writes", () => {
    const text = source()
    expect(text).not.toMatch(/CREATE TABLE/i)
    expect(text).not.toMatch(/INSERT INTO/i)
    expect(text).not.toMatch(/UPDATE \w+ SET/i)
    expect(text).not.toMatch(/DELETE FROM/i)
    expect(text).not.toContain("Layer.effect")
    expect(text).not.toContain("Context.Tag")
  })

  it("reads through the existing repositories", () => {
    const text = source()
    expect(text).toContain("EvidenceLineageRepository")
    expect(text).toContain("ProductReadRepository")
    expect(text).toContain("InterventionRow")
    expect(text).toContain("ReobservationRow")
  })

  it("computes match/change/outcome only via protocol measurement fns", () => {
    const text = source()
    expect(text).toContain('from "@openrecord/protocol"')
    for (const fn of ["compareMeasurements", "deriveObservedChange", "deriveOutcome", "latestJudgment", "soleClaim", "measurementSignature"]) {
      expect(text, `missing protocol import: ${fn}`).toContain(fn)
    }
    expect(text).not.toContain("const compareMeasurements")
    expect(text).not.toContain("const deriveOutcome")
    expect(text).not.toContain("function compareMeasurements")
    expect(text).not.toContain("function deriveOutcome")
  })

  it("keeps responses inside the allowed outcome vocabulary", () => {
    const text = source()
    for (const copy of Object.values(LOOP_DISPLAY_COPY)) expect(text).toContain(copy)
    expect(Object.values(LOOP_DISPLAY_COPY)).toEqual([
      "AI answer changed afterward",
      "No representation change observed",
      "Not enough comparable evidence",
      "Not rechecked yet",
      "Needs review",
    ])
  })

  it("uses no causal wording in the module or its output", () => {
    const loop = buildIssueLoop({
      ...baseArgs(),
      interventions: [intervention("01")],
      reobservations: [reobservation(REOBS, OBS_AFTER)],
      claims: [claim(CLAIM, OBS_BEFORE), claim(AFTER_CLAIM, OBS_AFTER)],
      judgments: [
        judgment("j1111111-1111-4111-8111-111111111111", CLAIM, "CONTRADICTED"),
        judgment("j2222222-2222-4222-8222-222222222222", AFTER_CLAIM, "SUPPORTED"),
      ],
      afterObservations: new Map([[OBS_AFTER, obs(OBS_AFTER, "Starter is $59 per month", ctx(PROMPT, RUN_AFTER))]]),
    })
    for (const text of [source(), JSON.stringify(loop)]) {
      const lower = text.toLowerCase()
      for (const banned of ["caused", "fixed", "influenced", "chatgpt", "caused_by"]) {
        expect(lower, `banned wording: ${banned}`).not.toContain(banned)
      }
    }
    expect(loop.latestComparison?.displayCopy).toBe("AI answer changed afterward")
  })
})

describe("UNKNOWN preservation", () => {
  it("unreviewed issues keep null verdicts end to end", () => {
    const loop = buildIssueLoop({ ...baseArgs(), judgments: [] })
    expect(loop.issue.verdict).toBeNull()
    expect(loop.issue.state).toBe("NEEDS_REVIEW")
    expect(loop.originalObservation.verdict).toBeNull()
    expect(loop.originalJudgment).toBeNull()
    expect(loop.latestComparison).toBeNull()
    expect(loop.explicitUnknowns).toContainEqual({ subjectId: CLAIM, field: "verdict" })
  })

  it("unlinked actions stay SOURCE_UNKNOWN, never a guessed binding", () => {
    const loop = buildIssueLoop({ ...baseArgs(), interventions: [intervention("01")] })
    expect(loop.sourceVerification.change).toBe("SOURCE_UNKNOWN")
    expect(loop.sourceVerification.bindingId).toBeNull()
    expect(loop.explicitUnknowns).toContainEqual({ subjectId: CLAIM, field: "outcome_after_intervention" })
  })

  it("no actions means SOURCE_NOT_CHECKED with no outcome unknown", () => {
    const loop = buildIssueLoop({ ...baseArgs(), judgments: [] })
    expect(loop.sourceVerification).toMatchObject({ change: "SOURCE_NOT_CHECKED", bindingId: null, beforeObservationId: null, afterObservationId: null })
    expect(loop.explicitUnknowns.some((u) => u.field === "outcome_after_intervention")).toBe(false)
    expect(loop.explicitUnknowns.some((u) => u.field === "causal_attribution")).toBe(false)
  })

  it("source verification is states, never a manual boolean", () => {
    const loop = buildIssueLoop({ ...baseArgs(), interventions: [intervention("01")] })
    expect(Object.keys(loop.sourceVerification).sort()).toEqual(["afterObservationId", "afterValue", "alignment", "beforeObservationId", "beforeValue", "bindingId", "change", "detail", "documentChanged"])
    expect(typeof loop.sourceVerification.change).toBe("string")
    expect(JSON.stringify(loop.sourceVerification)).not.toMatch(/fixed|resolved|success/i)
  })
})

describe("deriveSourceVerification: value change on explicit bindings", () => {
  // Intervention performed 2026-10-02; before < performed <= after.
  // Approved value is $59 throughout (alignment reuses the finding).
  const binding = (findingState: string, bindingId = "b-linked", targetId = "t-1", comparator = "MONEY") => ({
    bindingId, targetId, findingState, comparator,
  })
  const srcObs = (id: string, completedAt: string, digest: string | null, collectionState = "FETCHED", targetId = "t-1") => ({
    id,
    targetId,
    collectionState,
    failure: collectionState === "FAILED" ? "TIMEOUT" : null,
    completedAt,
    bodyDigest: digest,
  })
  const val = (bindingId: string, observationId: string, extractedValue: string | null, extractionState = "OBSERVED") => ({
    bindingId, observationId, extractedValue, extractionState,
  })
  const rel = (bindingId = "b-linked", before: string | null = "o-before") => ({
    interventionId: "c0000000-0000-4000-8000-000000000001",
    sourceBindingId: bindingId,
    beforeSourceObservationId: before,
  })
  const interventions = [intervention("01")]
  const BEFORE = "2026-10-01T12:00:00.000Z"
  const AFTER = "2026-10-03T12:00:00.000Z"
  const args = (overrides: {
    relations?: ReturnType<typeof rel>[]
    bindings?: ReturnType<typeof binding>[]
    observations?: ReturnType<typeof srcObs>[]
    values?: ReturnType<typeof val>[]
  }) => ({
    interventions,
    relations: overrides.relations ?? [rel()],
    bindings: overrides.bindings ?? [binding("IN_SYNC")],
    observations: overrides.observations ?? [],
    values: overrides.values ?? [],
  })

  it("1. before $49, after $59: CHANGED and IN_SYNC", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("IN_SYNC")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d2")],
      values: [val("b-linked", "o-before", "49 USD"), val("b-linked", "o-after", "59 USD")],
    }))
    expect(v).toMatchObject({
      bindingId: "b-linked", alignment: "IN_SYNC", change: "SOURCE_CHANGED",
      beforeObservationId: "o-before", afterObservationId: "o-after",
      beforeValue: "49 USD", afterValue: "59 USD",
    })
  })

  it("2. before $49, after $39: CHANGED and DRIFT", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("DRIFT")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d3")],
      values: [val("b-linked", "o-before", "49 USD"), val("b-linked", "o-after", "39 USD")],
    }))
    expect(v).toMatchObject({ alignment: "DRIFT", change: "SOURCE_CHANGED" })
  })

  it("3. before $49, after $49: UNCHANGED and DRIFT", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("DRIFT")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d1")],
      values: [val("b-linked", "o-before", "49 USD"), val("b-linked", "o-after", "49 USD")],
    }))
    expect(v).toMatchObject({ alignment: "DRIFT", change: "SOURCE_UNCHANGED" })
  })

  it("4. before $59, after $59: UNCHANGED and IN_SYNC", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("IN_SYNC")],
      observations: [srcObs("o-before", BEFORE, "d2"), srcObs("o-after", AFTER, "d2")],
      values: [val("b-linked", "o-before", "59 USD"), val("b-linked", "o-after", "59 USD")],
    }))
    expect(v).toMatchObject({ alignment: "IN_SYNC", change: "SOURCE_UNCHANGED" })
  })

  it("5. page bytes change but bound value stays $49: UNCHANGED", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("DRIFT")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d9-different-bytes")],
      values: [val("b-linked", "o-before", "49 USD"), val("b-linked", "o-after", "49 USD")],
    }))
    expect(v.change).toBe("SOURCE_UNCHANGED")
    expect(v.documentChanged).toBe(true)
  })

  it("6. 304 reuse resolves the carried value: UNCHANGED", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("DRIFT")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d1", "NOT_MODIFIED")],
      values: [val("b-linked", "o-before", "49 USD")],
    }))
    expect(v).toMatchObject({ change: "SOURCE_UNCHANGED", afterValue: "49 USD" })
  })

  it("MONEY follows canonicalizer, not strings: $49.00 equals $49", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("DRIFT")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d2")],
      values: [val("b-linked", "o-before", "49 USD"), val("b-linked", "o-after", "$49.00")],
    }))
    expect(v.change).toBe("SOURCE_UNCHANGED")
  })

  it("BOOLEAN and TEXT follow their comparator semantics", () => {
    const bool = deriveSourceVerification(args({
      bindings: [binding("DRIFT", "b-linked", "t-1", "BOOLEAN")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d2")],
      values: [val("b-linked", "o-before", "no"), val("b-linked", "o-after", "false")],
    }))
    expect(bool.change).toBe("SOURCE_UNCHANGED")
    const textSame = deriveSourceVerification(args({
      bindings: [binding("DRIFT", "b-linked", "t-1", "EXACT_TEXT")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d2")],
      values: [val("b-linked", "o-before", "24 hours"), val("b-linked", "o-after", "24 hours")],
    }))
    expect(textSame.change).toBe("SOURCE_UNCHANGED")
    const textDiff = deriveSourceVerification(args({
      bindings: [binding("DRIFT", "b-linked", "t-1", "EXACT_TEXT")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d2")],
      values: [val("b-linked", "o-before", "24 hours"), val("b-linked", "o-after", "48 hours")],
    }))
    expect(textDiff.change).toBe("SOURCE_CHANGED")
  })

  it("7. before missing: UNKNOWN", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("DRIFT")],
      observations: [srcObs("o-after", AFTER, "d2")],
      values: [val("b-linked", "o-after", "59 USD")],
    }))
    expect(v.change).toBe("SOURCE_UNKNOWN")
  })

  it("8. after not checked: NOT_CHECKED", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("DRIFT")],
      observations: [srcObs("o-before", BEFORE, "d1")],
      values: [val("b-linked", "o-before", "49 USD")],
    }))
    expect(v).toMatchObject({ change: "SOURCE_NOT_CHECKED", beforeObservationId: "o-before", afterObservationId: null })
  })

  it("9. after fetch failure: OBSERVATION_FAILED, never unchanged", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("UNKNOWN")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-failed", AFTER, null, "FAILED")],
      values: [val("b-linked", "o-before", "49 USD")],
    }))
    expect(v).toMatchObject({ change: "SOURCE_OBSERVATION_FAILED", afterObservationId: "o-failed" })
  })

  it("10. after extraction fails: UNKNOWN", () => {
    const v = deriveSourceVerification(args({
      bindings: [binding("DRIFT")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d2")],
      values: [val("b-linked", "o-before", "49 USD"), val("b-linked", "o-after", null, "FAILED")],
    }))
    expect(v.change).toBe("SOURCE_UNKNOWN")
  })

  it("11. evidence on another binding alone never decides this binding", () => {
    const v = deriveSourceVerification(args({
      relations: [rel("b-a", "o-a-before")],
      bindings: [binding("DRIFT", "b-a", "t-a")],
      observations: [{ ...srcObs("o-b-after", AFTER, "d9"), targetId: "t-b" }],
      values: [{ ...val("b-b", "o-b-after", "59 USD"), bindingId: "b-b" }],
    }))
    expect(v.change).toBe("SOURCE_UNKNOWN")
  })

  it("before without any after reads NOT_CHECKED, not unknown", () => {
    const v = deriveSourceVerification(args({
      relations: [rel("b-a", "o-a-before")],
      bindings: [binding("DRIFT", "b-a", "t-a")],
      observations: [{ ...srcObs("o-a-before", BEFORE, "d1"), targetId: "t-a" }],
      values: [val("b-a", "o-a-before", "49 USD")],
    }))
    expect(v).toMatchObject({ change: "SOURCE_NOT_CHECKED", beforeObservationId: "o-a-before" })
  })

  it("12. matching digests without a relation cannot nominate a binding", () => {
    const v = deriveSourceVerification(args({
      relations: [],
      bindings: [binding("DRIFT")],
      observations: [srcObs("o-before", BEFORE, "d1"), srcObs("o-after", AFTER, "d2")],
      values: [val("b-linked", "o-before", "49 USD"), val("b-linked", "o-after", "59 USD")],
    }))
    expect(v).toMatchObject({ change: "SOURCE_UNKNOWN", bindingId: null })
  })

  it("13. historical intervention without a relation stays UNKNOWN", () => {
    const v = deriveSourceVerification(args({
      relations: [],
      bindings: [],
      observations: [],
      values: [],
    }))
    expect(v.change).toBe("SOURCE_UNKNOWN")
  })

  it("disagreeing bindings stay UNKNOWN rather than picking a winner", () => {
    const v = deriveSourceVerification(args({
      relations: [rel("b-a", "o-a-before"), rel("b-b", "o-b-before")],
      bindings: [binding("IN_SYNC", "b-a", "t-a"), binding("DRIFT", "b-b", "t-b")],
      observations: [
        { ...srcObs("o-a-before", BEFORE, "d1"), targetId: "t-a" },
        { ...srcObs("o-a-after", AFTER, "d2"), targetId: "t-a" },
        { ...srcObs("o-b-before", BEFORE, "d9"), targetId: "t-b" },
        { ...srcObs("o-b-after", AFTER, "d9"), targetId: "t-b" },
      ],
      values: [
        val("b-a", "o-a-before", "49 USD"),
        val("b-a", "o-a-after", "59 USD"),
        val("b-b", "o-b-before", "49 USD"),
        val("b-b", "o-b-after", "49 USD"),
      ],
    }))
    expect(v.change).toBe("SOURCE_UNKNOWN")
    expect(v.bindingId).toBeNull()
  })
})

describe("reobservation attempts derive from durable intents", () => {
  const RUN_Q = "11111111-1111-4111-8111-111111111111"
  const INTENT = (n: string, runId: string): ReobservationIntentRow => ({
    id: `d0000000-0000-4000-8000-0000000000${n}`,
    businessId: BIZ,
    issueId: CLAIM,
    originalObservationId: OBS_BEFORE,
    interventionId: null,
    checkRunId: runId,
    createdByUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    createdAt: "2026-10-02T00:00:00.000Z",
  })
  const RUN = (id: string, status: string): CheckRunRow => ({
    id,
    businessId: BIZ,
    questionId: QUESTION,
    provider: "mock",
    requestedModel: "model-x",
    status,
    queuedAt: "2026-10-02T01:00:00.000Z",
    startedAt: status === "QUEUED" ? null : "2026-10-02T01:01:00.000Z",
    completedAt: status === "QUEUED" || status === "RUNNING" ? null : "2026-10-02T01:02:00.000Z",
    failureClass: status === "FAILED" ? "PROVIDER_TIMEOUT" : null,
    failureDetailSafe: status === "FAILED" ? "provider request timed out" : null,
    attemptCount: 1,
  })
  const withAttempts = (
    intents: ReobservationIntentRow[],
    runs: CheckRunRow[],
    obsByRun: ReadonlyMap<string, string> = new Map(),
    links: ReobservationRow[] = [],
  ) =>
    buildIssueLoop({
      ...baseArgs(),
      interventions: [intervention("01")],
      intents,
      checkRuns: new Map(runs.map((r) => [r.id, r])),
      runObservations: obsByRun,
      reobservations: links,
    }).reobservationAttempts

  it("1. intent + QUEUED run reads QUEUED with no observation or link", () => {
    const [a] = withAttempts([INTENT("01", RUN_Q)], [RUN(RUN_Q, "QUEUED")])
    expect(a).toMatchObject({ intentId: INTENT("01", RUN_Q).id, checkRunId: RUN_Q, state: "QUEUED", observationId: null, reobservationId: null })
  })

  it("2. intent + RUNNING run reads RUNNING", () => {
    const [a] = withAttempts([INTENT("01", RUN_Q)], [RUN(RUN_Q, "RUNNING")])
    expect(a?.state).toBe("RUNNING")
  })

  it("3. intent + FAILED run reads FAILED with failure class and no outcome", () => {
    const [a] = withAttempts([INTENT("01", RUN_Q)], [RUN(RUN_Q, "FAILED")], new Map([[RUN_Q, OBS_AFTER]]))
    expect(a).toMatchObject({ state: "FAILED", failureClass: "PROVIDER_TIMEOUT", observationId: OBS_AFTER, reobservationId: null })
  })

  it("4. SUCCEEDED + observation + link reads COMPLETED", () => {
    const [a] = withAttempts(
      [INTENT("01", RUN_Q)],
      [RUN(RUN_Q, "SUCCEEDED")],
      new Map([[RUN_Q, OBS_AFTER]]),
      [reobservation(REOBS, OBS_AFTER)],
    )
    expect(a).toMatchObject({ state: "COMPLETED", observationId: OBS_AFTER, reobservationId: REOBS })
  })

  it("SUCCEEDED + observation without a link reads FINALIZING, never completed", () => {
    const [a] = withAttempts([INTENT("01", RUN_Q)], [RUN(RUN_Q, "SUCCEEDED")], new Map([[RUN_Q, OBS_AFTER]]), [])
    expect(a?.state).toBe("FINALIZING")
  })

  it("5+6. historical attempts keep chronology; failed then successful both retained", () => {
    const r1 = { ...RUN("11111111-1111-4111-8111-111111111112", "FAILED") }
    const r2 = { ...RUN("11111111-1111-4111-8111-111111111113", "SUCCEEDED") }
    const list = withAttempts(
      [INTENT("01", r1.id), INTENT("02", r2.id)],
      [r1, r2],
      new Map([[r2.id, OBS_AFTER]]),
      [reobservation(REOBS, OBS_AFTER)],
    )
    expect(list.map((a) => a.state)).toEqual(["FAILED", "COMPLETED"])
    expect(list.map((a) => a.intentId)).toEqual([INTENT("01", r1.id).id, INTENT("02", r2.id).id])
  })
})

describe("INDETERMINATE on unreviewed or ambiguous rechecks", () => {
  const reviewedBefore = () => ({
    ...baseArgs(),
    reobservations: [reobservation(REOBS, OBS_AFTER)],
    afterObservations: new Map([[OBS_AFTER, obs(OBS_AFTER, "Starter is $59 per month", ctx(PROMPT, RUN_AFTER))]]),
  })

  it("an unreviewed after-claim forces INDETERMINATE with review copy", () => {
    const loop = buildIssueLoop({
      ...reviewedBefore(),
      claims: [claim(CLAIM, OBS_BEFORE), claim(AFTER_CLAIM, OBS_AFTER)],
    })
    const comparison = loop.latestComparison
    expect(comparison).not.toBeNull()
    expect(comparison?.matchClassification).toBe("EXACT_MATCH")
    expect(comparison?.after.verdict).toBeNull()
    expect(comparison?.outcome).toBe("INDETERMINATE")
    expect(comparison?.displayCopy).toBe("Needs review")
    expect(comparison?.causalAttribution).toBe("UNKNOWN")
    expect(loop.explicitUnknowns).toContainEqual({ subjectId: REOBS, field: "after_verdict" })
  })

  it("multiple after-claims force INDETERMINATE with an after_claim unknown", () => {
    const loop = buildIssueLoop({
      ...reviewedBefore(),
      claims: [claim(CLAIM, OBS_BEFORE), claim(AFTER_CLAIM, OBS_AFTER), claim(AFTER_CLAIM_2, OBS_AFTER, "Starter is $59")],
      judgments: [
        judgment("j1111111-1111-4111-8111-111111111111", CLAIM, "CONTRADICTED"),
        judgment("j2222222-2222-4222-8222-222222222222", AFTER_CLAIM, "SUPPORTED"),
      ],
    })
    expect(loop.latestComparison?.after.claimId).toBeNull()
    expect(loop.latestComparison?.after.verdict).toBeNull()
    expect(loop.latestComparison?.outcome).toBe("INDETERMINATE")
    expect(loop.latestComparison?.displayCopy).toBe("Needs review")
    expect(loop.explicitUnknowns).toContainEqual({ subjectId: REOBS, field: "after_claim" })
  })
})

describe("MEASUREMENT_FAILED separation", () => {
  it("incomplete measurement details stay distinguishable from comparison results", () => {
    const failed = buildLoopComparison({
      reobservationId: REOBS,
      interventionId: null,
      beforeObservation: obs(OBS_BEFORE, "Starter is $29 per month", ctx(PROMPT, RUN_BEFORE)),
      // Legacy row with no stored context and no prompt to rebuild from.
      afterObservation: obs(OBS_AFTER, "Starter is $59 per month", null, { prompt: null }),
      beforeClaim: claim(CLAIM, OBS_BEFORE),
      beforeJudgment: judgment("j1111111-1111-4111-8111-111111111111", CLAIM, "CONTRADICTED"),
      afterClaim: claim(AFTER_CLAIM, OBS_AFTER),
      afterJudgment: judgment("j2222222-2222-4222-8222-222222222222", AFTER_CLAIM, "SUPPORTED"),
    })
    expect(failed.measurementStatus).toBe("MEASUREMENT_FAILED")
    expect(failed.matchClassification).toBe("INDETERMINATE")
    expect(failed.observedChange).toBe("INDETERMINATE")
    expect(failed.outcome).toBe("INDETERMINATE")
    expect(failed.displayCopy).toBe("Not enough comparable evidence")

    const ok = buildLoopComparison({
      reobservationId: REOBS,
      interventionId: null,
      beforeObservation: obs(OBS_BEFORE, "Starter is $29 per month", ctx(PROMPT, RUN_BEFORE)),
      afterObservation: obs(OBS_AFTER, "Starter is $59 per month", ctx(PROMPT, RUN_AFTER)),
      beforeClaim: claim(CLAIM, OBS_BEFORE),
      beforeJudgment: judgment("j1111111-1111-4111-8111-111111111111", CLAIM, "CONTRADICTED"),
      afterClaim: claim(AFTER_CLAIM, OBS_AFTER),
      afterJudgment: judgment("j2222222-2222-4222-8222-222222222222", AFTER_CLAIM, "SUPPORTED"),
    })
    expect(ok.measurementStatus).toBe("OK")
    expect(ok.matchClassification).toBe("EXACT_MATCH")
    expect(ok.observedChange).toBe("CHANGED")
    expect(ok.outcome).toBe("OBSERVED_CORRECTION")
  })

  it("legacy rows rebuild contexts from stored columns when complete", () => {
    const rebuilt = toLoopMeasurementContext(obs(OBS_BEFORE, "Starter is $29 per month", null))
    expect(rebuilt).not.toBeNull()
    expect(toLoopMeasurementContext(obs(OBS_BEFORE, "Starter is $29 per month", null, { prompt: null }))).toBeNull()
  })

  it("different questions are NOT_COMPARABLE, unknown dimensions INDETERMINATE", () => {
    const different = buildLoopComparison({
      reobservationId: REOBS,
      interventionId: null,
      beforeObservation: obs(OBS_BEFORE, "Starter is $29 per month", ctx(PROMPT, RUN_BEFORE)),
      afterObservation: obs(OBS_AFTER, "Starter is $29 per month", ctx(PROMPT_OTHER, RUN_AFTER)),
      beforeClaim: claim(CLAIM, OBS_BEFORE),
      beforeJudgment: judgment("j1111111-1111-4111-8111-111111111111", CLAIM, "CONTRADICTED"),
      afterClaim: claim(AFTER_CLAIM, OBS_AFTER),
      afterJudgment: judgment("j2222222-2222-4222-8222-222222222222", AFTER_CLAIM, "SUPPORTED"),
    })
    expect(different.matchClassification).toBe("NOT_COMPARABLE")
    expect(different.outcome).toBe("INDETERMINATE")
    expect(different.displayCopy).toBe("Not enough comparable evidence")

    const routerCtx = (runId: string) => ctx(PROMPT, runId, "9router")
    const partial = buildLoopComparison({
      reobservationId: REOBS,
      interventionId: null,
      beforeObservation: { ...obs(OBS_BEFORE, "Starter is $29 per month", routerCtx(RUN_BEFORE)), provider: "9router" },
      afterObservation: { ...obs(OBS_AFTER, "Starter is $29 per month", routerCtx(RUN_AFTER)), provider: "9router" },
      beforeClaim: claim(CLAIM, OBS_BEFORE),
      beforeJudgment: judgment("j1111111-1111-4111-8111-111111111111", CLAIM, "CONTRADICTED"),
      afterClaim: claim(AFTER_CLAIM, OBS_AFTER),
      afterJudgment: judgment("j2222222-2222-4222-8222-222222222222", AFTER_CLAIM, "SUPPORTED"),
    })
    expect(partial.matchClassification).toBe("INDETERMINATE")
    expect(partial.displayCopy).toBe("Not enough comparable evidence")
  })

  it("identical answers under comparable conditions report no change", () => {
    const same = buildLoopComparison({
      reobservationId: REOBS,
      interventionId: null,
      beforeObservation: obs(OBS_BEFORE, "Starter is $29 per month", ctx(PROMPT, RUN_BEFORE)),
      afterObservation: obs(OBS_AFTER, "Starter is $29 per month", ctx(PROMPT, RUN_AFTER)),
      beforeClaim: claim(CLAIM, OBS_BEFORE),
      beforeJudgment: judgment("j1111111-1111-4111-8111-111111111111", CLAIM, "CONTRADICTED"),
      afterClaim: claim(AFTER_CLAIM, OBS_AFTER),
      afterJudgment: judgment("j2222222-2222-4222-8222-222222222222", AFTER_CLAIM, "CONTRADICTED"),
    })
    expect(same.observedChange).toBe("NO_CHANGE")
    expect(same.outcome).toBe("NO_OBSERVED_CHANGE")
    expect(same.displayCopy).toBe("No representation change observed")
    expect(same.causalAttribution).toBe("UNKNOWN")
  })
})

describe("issue loop tenancy", () => {
  const BusinessStub = Layer.succeed(BusinessRepository, {
    create: () => Effect.dieMessage("unused"),
    list: () => Effect.succeed([]),
    getScoped: (accountId: string, id: string) =>
      Effect.succeed(
        accountId === "acct-a" && id === BIZ
          ? { id: BIZ, accountId: "acct-a", name: "Acme", createdAt: "2026-10-01T00:00:00.000Z" }
          : null,
      ),
  })

  const LineageStub = Layer.succeed(EvidenceLineageRepository, {
    loadIssue: (accountId: string, businessId: string, issueId: string) =>
      Effect.succeed(
        accountId === "acct-a" && businessId === BIZ && issueId === CLAIM
          ? {
              business: { id: BIZ, name: "Acme" },
              claim: {
                id: CLAIM,
                business_id: BIZ,
                observation_id: OBS_BEFORE,
                text: "Starter is $29 per month",
                origin: "MANUAL_TRANSCRIPTION",
                created_at: "2026-10-01T00:00:00.000Z",
              },
              observations: [
                {
                  id: OBS_BEFORE,
                  business_id: BIZ,
                  check_run_id: RUN_BEFORE,
                  provider: "mock",
                  requested_model: "model-x",
                  observed_model: "model-x",
                  collected_at: "2026-10-01T10:00:00.000Z",
                  answer_text: "Starter is $29 per month",
                  measurement_context: ctx(PROMPT, RUN_BEFORE),
                  question_id: QUESTION,
                  question_prompt: PROMPT,
                },
              ],
              citations: [],
              claims: [
                {
                  id: CLAIM,
                  business_id: BIZ,
                  observation_id: OBS_BEFORE,
                  text: "Starter is $29 per month",
                  origin: "MANUAL_TRANSCRIPTION",
                  created_at: "2026-10-01T00:00:00.000Z",
                },
              ],
              judgments: [
                {
                  id: "j1111111-1111-4111-8111-111111111111",
                  business_id: BIZ,
                  claim_id: CLAIM,
                  verdict: "CONTRADICTED",
                  notes: null,
                  fact_ids: [],
                  supersedes_id: null,
                  created_at: "2026-10-01T11:00:00.000Z",
                },
              ],
              facts: [],
              interventions: [],
              reobservations: [],
            }
          : null,
      ),
  })

  const ReadsStub = Layer.succeed(ProductReadRepository, {
    authorityMode: () => Effect.succeed(null),
    factProvenance: () => Effect.succeed([]),
    factHistory: () => Effect.succeed([]),
    factLineage: () => Effect.succeed([]),
    targets: () => Effect.succeed([]),
    bindings: () => Effect.succeed([]),
    binding: () => Effect.succeed(null),
    observations: () => Effect.succeed([]),
    values: () => Effect.succeed([]),
    aiCitations: () => Effect.succeed([]),
    createBinding: () => Effect.dieMessage("unused"),
    findBindingExact: () => Effect.succeed(null),
    issueList: () => Effect.succeed([]),
    issueDetailRow: () => Effect.succeed(null),
  })

  const FactStub = Layer.succeed(FactRepository, {
    create: () => Effect.dieMessage("unused"),
    listByBusiness: () => Effect.succeed([]),
    getScoped: () => Effect.succeed(null),
    supersede: () => Effect.dieMessage("unused"),
    retire: () => Effect.succeed(null),
    activeOverlapping: () => Effect.succeed([]),
  })

  const IntentStub = Layer.succeed(ReobservationIntentRepository, {
    createIntent: () => Effect.dieMessage("unused"),
    enqueueReobservation: () => Effect.dieMessage("unused"),
    listByIssue: () => Effect.succeed([]),
    resolveIntent: () => Effect.succeed(null),
  })

  const CheckStub = Layer.succeed(CheckRunRepository, {
    enqueue: () => Effect.dieMessage("unused"),
    listByBusiness: () => Effect.succeed([]),
    getScoped: () => Effect.succeed(null),
    claimOne: () => Effect.succeed(null),
    markRunning: () => Effect.void,
    recordAttempt: () => Effect.succeed(1),
    recoverAbandoned: () => Effect.succeed(0),
    markFinished: () => Effect.void,
  })

  const ObsStub = Layer.succeed(ObservationRepository, {
    create: () => Effect.dieMessage("unused"),
    getScoped: () => Effect.succeed(null),
    getByCheckRun: () => Effect.succeed(null),
    finalizeReobservationForCheckRun: () => Effect.succeed(null),
    sweepUnfulfilledReobservations: () => Effect.succeed(0),
  })

  const BindingStub = Layer.succeed(InterventionBindingRepository, {
    linkInterventionBinding: () => Effect.dieMessage("unused"),
    listByIssue: () => Effect.succeed([]),
  })

  const env = Layer.mergeAll(BusinessStub, LineageStub, ReadsStub, FactStub, IntentStub, CheckStub, ObsStub, BindingStub)

  it("loads the loop for the owning account", async () => {
    const loop = await Effect.runPromise(loadIssueLoop("acct-a", BIZ, CLAIM).pipe(Effect.provide(env)))
    expect(loop?.issue).toMatchObject({ claimId: CLAIM, observationId: OBS_BEFORE, verdict: "CONTRADICTED", state: "WRONG" })
    expect(loop?.originalJudgment).toMatchObject({ verdict: "CONTRADICTED" })
    expect(loop?.latestComparison).toBeNull()
    expect(loop?.reobservationAttempts).toEqual([])
  })

  it("another account sees nothing", async () => {
    expect(await Effect.runPromise(loadIssueLoop("acct-b", BIZ, CLAIM).pipe(Effect.provide(env)))).toBeNull()
  })

  it("unknown claims read as null", async () => {
    expect(await Effect.runPromise(loadIssueLoop("acct-a", BIZ, UNKNOWN_CLAIM).pipe(Effect.provide(env)))).toBeNull()
  })
})
