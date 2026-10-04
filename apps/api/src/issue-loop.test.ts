// Issue-loop read model: derivation rules asserted DB-free. Stubbed Effect
// layers cover tenancy; the pure builder covers UNKNOWN preservation,
// INDETERMINATE on unreviewed/ambiguous rechecks, MEASUREMENT_FAILED
// separation, and the protocol-only comparison rule.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { knownValue, PROTOCOL_VERSION, schemaId, surfaceForWorker } from "@ghostping/protocol"
import {
  BusinessRepository,
  EvidenceLineageRepository,
  FactRepository,
  ProductReadRepository,
  type InterventionRow,
  type ReobservationRow,
} from "@ghostping/db"
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
  sourceLinks: [],
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
    expect(text).toContain('from "@ghostping/protocol"')
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
    expect(loop.sourceVerification.state).toBe("SOURCE_UNKNOWN")
    expect(loop.sourceVerification.linkedBindingId).toBeNull()
    expect(loop.explicitUnknowns).toContainEqual({ subjectId: CLAIM, field: "outcome_after_intervention" })
  })

  it("no actions means SOURCE_NOT_CHECKED with no outcome unknown", () => {
    const loop = buildIssueLoop({ ...baseArgs(), judgments: [] })
    expect(loop.sourceVerification).toMatchObject({ state: "SOURCE_NOT_CHECKED", linkedBindingId: null, linkedObservationId: null })
    expect(loop.explicitUnknowns.some((u) => u.field === "outcome_after_intervention")).toBe(false)
    expect(loop.explicitUnknowns.some((u) => u.field === "causal_attribution")).toBe(false)
  })

  it("source verification is a state string, never a manual boolean", () => {
    const loop = buildIssueLoop({ ...baseArgs(), interventions: [intervention("01")] })
    expect(Object.keys(loop.sourceVerification).sort()).toEqual(["detail", "linkedBindingId", "linkedObservationId", "state"])
    expect(typeof loop.sourceVerification.state).toBe("string")
    expect(JSON.stringify(loop.sourceVerification)).not.toMatch(/fixed|resolved|success/i)
  })
})

describe("deriveSourceVerification", () => {
  const link = (findingState: string, extra?: { collectionState?: string; failure?: string | null }) => ({
    observationId: "o-linked",
    bindingId: "b-linked",
    findingState,
    collectionState: extra?.collectionState ?? "FETCHED",
    failure: extra?.failure ?? null,
    completedAt: "2026-10-02T12:00:00.000Z",
  })

  it("maps linked tracked evidence to the observed states", () => {
    const interventions = [intervention("01")]
    expect(deriveSourceVerification({ interventions, links: [link("IN_SYNC")] }).state).toBe("SOURCE_OBSERVED_UNCHANGED")
    expect(deriveSourceVerification({ interventions, links: [link("DRIFT")] }).state).toBe("SOURCE_OBSERVED_CHANGED")
    expect(deriveSourceVerification({ interventions, links: [link("IN_SYNC", { collectionState: "FAILED", failure: "TIMEOUT" })] }).state).toBe(
      "SOURCE_OBSERVATION_FAILED",
    )
    expect(deriveSourceVerification({ interventions, links: [link("UNKNOWN")] }).state).toBe("SOURCE_UNKNOWN")
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

  const env = Layer.mergeAll(BusinessStub, LineageStub, ReadsStub, FactStub)

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
