// Durable re-check product surface: tenancy (account B reaches nothing of
// account A's issues), server-side derivation (same question/provider/
// model as the original check; the body carries no prompt to substitute),
// unrelated-intervention rejection, and the attempts listing (intents plus
// check statuses plus finalized lineage links). DB-free: stubbed Effect
// layers plus the contract schemas, mirroring interventions.test.ts.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Effect, Layer, Schema } from "effect"
import {
  CheckRunRepository,
  ClaimRepository,
  InterventionRepository,
  ObservationRepository,
  ReobservationIntentRepository,
  ReobservationRepository,
  type CheckRunRow,
  type InterventionRow,
  type ObservationRow,
  type ReobservationIntentRow,
  type ReobservationRow,
} from "@ghostping/db"
import { CreateReobservationRequest, decodeRouteId } from "@ghostping/contracts"
import { listRecheckAttempts, requestRecheck } from "./reobservations.js"

const BIZ_A = "11111111-1111-4111-8111-111111111111"
const BIZ_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OBS_ORIG = "33333333-3333-4333-8333-333333333333"
const OBS_AFTER = "55555555-5555-4555-8555-555555555555"
const CLAIM_A = "22222222-2222-4222-8222-222222222222"
const CLAIM_UNKNOWN = "44444444-4444-4444-8444-444444444444"
const Q_A = "66666666-6666-4666-8666-666666666666"
const RUN_PRIOR = "77777777-7777-4777-8777-777777777777"
const IV_LINKED = "88888888-8888-4888-8888-888888888888"
const IV_OTHER = "99999999-9999-4999-8999-999999999999"
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const iso = "2026-10-01T00:00:00.000Z"

const ClaimStub = Layer.succeed(ClaimRepository, {
  create: () => Effect.dieMessage("unused"),
  listByBusiness: () => Effect.succeed([]),
  getScoped: (businessId: string, id: string) =>
    Effect.succeed(
      businessId === BIZ_A && id === CLAIM_A
        ? {
          id: CLAIM_A,
          businessId: BIZ_A,
          observationId: OBS_ORIG,
          text: "Acme Starter costs $29 per month",
          origin: "MANUAL_TRANSCRIPTION",
          createdAt: iso,
        }
        : null,
    ),
})

const checkRunRow = (id: string, status: string): CheckRunRow => ({
  id,
  businessId: BIZ_A,
  questionId: Q_A,
  provider: "mock",
  requestedModel: "requested",
  status,
  queuedAt: iso,
  startedAt: status === "QUEUED" ? null : iso,
  completedAt: status === "QUEUED" || status === "RUNNING" ? null : iso,
  failureClass: status === "FAILED" ? "PROVIDER_TIMEOUT" : null,
  failureDetailSafe: status === "FAILED" ? "provider request timed out" : null,
  attemptCount: status === "QUEUED" ? 0 : 1,
})

const makeRuns = () => {
  const enqueued: Array<{ businessId: string; questionId: string; provider: string; requestedModel: string | null }> = []
  let n = 0
  const extra = new Map<string, CheckRunRow>()
  const service = {
    enqueue: (input: { businessId: string; questionId: string; provider: string; requestedModel: string | null }) =>
      Effect.sync(() => {
        n += 1
        enqueued.push(input)
        const row = checkRunRow(`10000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, "QUEUED")
        extra.set(row.id, { ...row, businessId: input.businessId, questionId: input.questionId, provider: input.provider, requestedModel: input.requestedModel })
        return extra.get(row.id) as CheckRunRow
      }),
    listByBusiness: () => Effect.succeed([]),
    getScoped: (businessId: string, id: string) =>
      Effect.succeed(
        businessId === BIZ_A && id === RUN_PRIOR
          ? checkRunRow(RUN_PRIOR, "SUCCEEDED")
          : (businessId === BIZ_A ? extra.get(id) ?? null : null),
      ),
    claimOne: () => Effect.succeed(null),
    markRunning: () => Effect.void,
    recordAttempt: () => Effect.succeed(1),
    markFinished: () => Effect.void,
  }
  return { enqueued, extra, layer: Layer.succeed(CheckRunRepository, service) }
}

const observationRow = (id: string, checkRunId: string): ObservationRow => ({
  id,
  businessId: BIZ_A,
  checkRunId,
  provider: "mock",
  requestedModel: "requested",
  observedModel: "mock-v1",
  collectedAt: iso,
  answerText: "Northstar costs $29/month.",
  retrievalMode: "unknown",
  rawEvidenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  rawDigest: "d".repeat(64),
  surfaceIdentity: null,
  measurementContext: null,
  synthetic: true,
  citations: [],
})

const makeObservations = (byCheckRun: Record<string, ObservationRow>) => {
  const byId = new Map<string, ObservationRow>()
  for (const row of Object.values(byCheckRun)) byId.set(row.id, row)
  return Layer.succeed(ObservationRepository, {
    create: () => Effect.dieMessage("unused"),
    getScoped: (businessId: string, id: string) =>
      Effect.succeed(businessId === BIZ_A ? (byId.get(id) ?? null) : null),
    getByCheckRun: (checkRunId: string) =>
      Effect.succeed(byCheckRun[checkRunId] ?? null),
    finalizeReobservationForCheckRun: () => Effect.succeed(null),
    sweepUnfulfilledReobservations: () => Effect.succeed(0),
  })
}

const interventionRow = (id: string): InterventionRow => ({
  id,
  businessId: BIZ_A,
  issueIds: [CLAIM_A],
  type: "SOURCE_UPDATED",
  target: "https://acme.example/pricing",
  performedAt: iso,
  actor: "HUMAN",
  actorId: USER_A,
  notes: null,
  evidenceBeforeDigest: null,
  evidenceAfterDigest: null,
  supersedesId: null,
  correctionReason: null,
  createdAt: iso,
})

const InterventionStub = Layer.succeed(InterventionRepository, {
  append: () => Effect.dieMessage("unused"),
  listByIssue: (businessId: string, issueId: string) =>
    Effect.succeed(businessId === BIZ_A && issueId === CLAIM_A ? [interventionRow(IV_LINKED)] : []),
})

const makeIntents = () => {
  const rows: Array<ReobservationIntentRow> = []
  let n = 0
  const service = {
    createIntent: (input: {
      businessId: string
      issueId: string
      originalObservationId: string
      interventionId: string | null
      checkRunId: string
      createdByUserId: string
    }) =>
      Effect.sync(() => {
        n += 1
        const row: ReobservationIntentRow = {
          id: `20000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
          businessId: input.businessId,
          issueId: input.issueId,
          originalObservationId: input.originalObservationId,
          interventionId: input.interventionId,
          checkRunId: input.checkRunId,
          createdByUserId: input.createdByUserId,
          createdAt: iso,
        }
        rows.push(row)
        return row as ReobservationIntentRow | null
      }),
    listByIssue: (businessId: string, issueId: string) =>
      Effect.succeed(rows.filter((r) => r.businessId === businessId && r.issueId === issueId)),
    resolveIntent: (checkRunId: string) =>
      Effect.succeed(rows.find((r) => r.checkRunId === checkRunId) ?? null),
  }
  return { rows, service, layer: Layer.succeed(ReobservationIntentRepository, service) }
}

const makeLinks = (initial: Array<ReobservationRow> = []) =>
  Layer.succeed(ReobservationRepository, {
    append: () => Effect.dieMessage("unused"),
    listByIssue: (businessId: string, issueId: string) =>
      Effect.succeed(initial.filter((r) => r.businessId === businessId && r.issueId === issueId)),
  })

const linkRow = (observationId: string): ReobservationRow => ({
  id: "30000000-0000-4000-8000-000000000001",
  businessId: BIZ_A,
  originalObservationId: OBS_ORIG,
  issueId: CLAIM_A,
  interventionId: IV_LINKED,
  observationId,
  createdAt: iso,
})

describe("recheck derivation from the issue", () => {
  it("enqueues the same question/provider/model and records the intent", async () => {
    const runs = makeRuns()
    const intents = makeIntents()
    const env = Layer.mergeAll(
      ClaimStub,
      runs.layer,
      makeObservations({ [RUN_PRIOR]: observationRow(OBS_ORIG, RUN_PRIOR) }),
      InterventionStub,
      intents.layer,
    )
    const created = await Effect.runPromise(
      requestRecheck(BIZ_A, CLAIM_A, USER_A, { interventionId: IV_LINKED }).pipe(Effect.provide(env)),
    )
    expect(created).not.toBeNull()
    // Same runnable as the original check: derived, never from the body.
    expect(runs.enqueued).toEqual([{ businessId: BIZ_A, questionId: Q_A, provider: "mock", requestedModel: "requested" }])
    expect(created?.checkRun.questionId).toBe(Q_A)
    expect(created?.intent.issueId).toBe(CLAIM_A)
    expect(created?.intent.originalObservationId).toBe(OBS_ORIG)
    expect(created?.intent.checkRunId).toBe(created?.checkRun.id)
    expect(created?.intent.createdByUserId).toBe(USER_A)
    expect(created?.intent.interventionId).toBe(IV_LINKED)
  })

  it("records an intent without an intervention link", async () => {
    const runs = makeRuns()
    const intents = makeIntents()
    const env = Layer.mergeAll(
      ClaimStub,
      runs.layer,
      makeObservations({ [RUN_PRIOR]: observationRow(OBS_ORIG, RUN_PRIOR) }),
      InterventionStub,
      intents.layer,
    )
    const created = await Effect.runPromise(
      requestRecheck(BIZ_A, CLAIM_A, USER_A, { interventionId: null }).pipe(Effect.provide(env)),
    )
    expect(created?.intent.interventionId).toBeNull()
  })
})

describe("recheck tenancy", () => {
  it("account B cannot recheck or list account A's issue", async () => {
    const runs = makeRuns()
    const intents = makeIntents()
    const env = Layer.mergeAll(
      ClaimStub,
      runs.layer,
      makeObservations({ [RUN_PRIOR]: observationRow(OBS_ORIG, RUN_PRIOR) }),
      InterventionStub,
      intents.layer,
      makeLinks(),
    )
    // Cross-tenant reads are null (404 upstream), so no run is enqueued.
    expect(await Effect.runPromise(requestRecheck(BIZ_B, CLAIM_A, USER_B, { interventionId: null }).pipe(Effect.provide(env)))).toBeNull()
    expect(runs.enqueued).toHaveLength(0)
    expect(intents.rows).toHaveLength(0)
    expect(await Effect.runPromise(listRecheckAttempts(BIZ_B, CLAIM_A).pipe(Effect.provide(env)))).toBeNull()
  })

  it("unknown and malformed claim ids read as null (404 at the route)", async () => {
    const runs = makeRuns()
    const intents = makeIntents()
    const env = Layer.mergeAll(
      ClaimStub,
      runs.layer,
      makeObservations({ [RUN_PRIOR]: observationRow(OBS_ORIG, RUN_PRIOR) }),
      InterventionStub,
      intents.layer,
      makeLinks(),
    )
    expect(await Effect.runPromise(listRecheckAttempts(BIZ_A, CLAIM_UNKNOWN).pipe(Effect.provide(env)))).toBeNull()
    expect(await Effect.runPromise(requestRecheck(BIZ_A, CLAIM_UNKNOWN, USER_A, { interventionId: null }).pipe(Effect.provide(env)))).toBeNull()
    expect(decodeRouteId("not-a-uuid")._tag).toBe("Left")
  })
})

describe("recheck intervention linkage", () => {
  it("rejects interventions not linked to the issue without enqueueing", async () => {
    const runs = makeRuns()
    const intents = makeIntents()
    const env = Layer.mergeAll(
      ClaimStub,
      runs.layer,
      makeObservations({ [RUN_PRIOR]: observationRow(OBS_ORIG, RUN_PRIOR) }),
      InterventionStub,
      intents.layer,
    )
    const tagged = await Effect.runPromise(
      requestRecheck(BIZ_A, CLAIM_A, USER_A, { interventionId: IV_OTHER }).pipe(
        Effect.provide(env),
        Effect.catchTag("ReobservationInterventionMismatch", (e) => Effect.succeed(`mismatch:${e.reason}`)),
      ),
    )
    expect(String(tagged)).toMatch(/^mismatch:/)
    // Rejected before any persistence: no run, no intent.
    expect(runs.enqueued).toHaveLength(0)
    expect(intents.rows).toHaveLength(0)
  })
})

describe("recheck request validation", () => {
  const decode = Schema.decodeUnknownEither(CreateReobservationRequest)

  it("accepts absent, null, and UUID intervention links", () => {
    expect(decode({})._tag).toBe("Right")
    expect(decode({ interventionId: null })._tag).toBe("Right")
    expect(decode({ interventionId: IV_LINKED })._tag).toBe("Right")
  })

  it("rejects non-UUID intervention links", () => {
    expect(decode({ interventionId: "not-a-uuid" })._tag).toBe("Left")
  })

  it("prompt substitution is impossible: runnable fields are stripped and never read", () => {
    // Extra keys never survive decoding, and the helper signature only
    // accepts an explicit interventionId — there is no parameter a
    // substituted prompt, question, provider, or model could flow through.
    const decoded = decode({
      interventionId: IV_LINKED,
      prompt: "How much does Evilcorp cost?",
      questionId: Q_A,
      provider: "9router",
      requestedModel: "attacker-chosen",
      actor: "SYSTEM",
      actorId: USER_B,
    })
    expect(decoded._tag).toBe("Right")
    if (decoded._tag === "Right") {
      expect(Object.keys(decoded.right).sort()).toEqual(["interventionId"])
    }
    expect(requestRecheck.length).toBe(4)
  })
})

describe("recheck attempts listing", () => {
  it("joins intents to check statuses and finalized links", async () => {
    const runs = makeRuns()
    const doneId = "10000000-0000-4000-8000-000000000001"
    const pendingId = "10000000-0000-4000-8000-000000000002"
    runs.extra.set(doneId, checkRunRow(doneId, "SUCCEEDED"))
    runs.extra.set(pendingId, checkRunRow(pendingId, "QUEUED"))
    const intents = makeIntents()
    intents.rows.push(
      {
        id: "20000000-0000-4000-8000-000000000001",
        businessId: BIZ_A,
        issueId: CLAIM_A,
        originalObservationId: OBS_ORIG,
        interventionId: IV_LINKED,
        checkRunId: doneId,
        createdByUserId: USER_A,
        createdAt: iso,
      },
      {
        id: "20000000-0000-4000-8000-000000000002",
        businessId: BIZ_A,
        issueId: CLAIM_A,
        originalObservationId: OBS_ORIG,
        interventionId: null,
        checkRunId: pendingId,
        createdByUserId: USER_A,
        createdAt: iso,
      },
    )
    const env = Layer.mergeAll(
      ClaimStub,
      runs.layer,
      makeObservations({
        [RUN_PRIOR]: observationRow(OBS_ORIG, RUN_PRIOR),
        [doneId]: observationRow(OBS_AFTER, doneId),
      }),
      InterventionStub,
      intents.layer,
      makeLinks([linkRow(OBS_AFTER)]),
    )
    const attempts = await Effect.runPromise(listRecheckAttempts(BIZ_A, CLAIM_A).pipe(Effect.provide(env)))
    expect(attempts).not.toBeNull()
    expect(attempts).toHaveLength(2)
    // Finalized attempt: status plus lineage link, no outcome asserted.
    expect(attempts?.[0]?.checkRun?.status).toBe("SUCCEEDED")
    expect(attempts?.[0]?.observationId).toBe(OBS_AFTER)
    expect(attempts?.[0]?.reobservation?.observationId).toBe(OBS_AFTER)
    expect("outcome" in (attempts?.[0] ?? {})).toBe(false)
    // Pending attempt: queued status, retained intent, no link.
    expect(attempts?.[1]?.checkRun?.status).toBe("QUEUED")
    expect(attempts?.[1]?.observationId).toBeNull()
    expect(attempts?.[1]?.reobservation).toBeNull()
  })

  it("a failed check reads with its failure status and no link", async () => {
    const runs = makeRuns()
    const failedId = "10000000-0000-4000-8000-000000000003"
    runs.extra.set(failedId, checkRunRow(failedId, "FAILED"))
    const intents = makeIntents()
    intents.rows.push({
      id: "20000000-0000-4000-8000-000000000003",
      businessId: BIZ_A,
      issueId: CLAIM_A,
      originalObservationId: OBS_ORIG,
      interventionId: null,
      checkRunId: failedId,
      createdByUserId: USER_A,
      createdAt: iso,
    })
    const env = Layer.mergeAll(
      ClaimStub,
      runs.layer,
      makeObservations({ [RUN_PRIOR]: observationRow(OBS_ORIG, RUN_PRIOR) }),
      InterventionStub,
      intents.layer,
      makeLinks(),
    )
    const attempts = await Effect.runPromise(listRecheckAttempts(BIZ_A, CLAIM_A).pipe(Effect.provide(env)))
    expect(attempts?.[0]?.checkRun?.status).toBe("FAILED")
    expect(attempts?.[0]?.checkRun?.failureClass).toBe("PROVIDER_TIMEOUT")
    expect(attempts?.[0]?.observationId).toBeNull()
    expect(attempts?.[0]?.reobservation).toBeNull()
    // The intent is retained for a later recheck, never rewritten.
    expect(intents.rows).toHaveLength(1)
  })
})

describe("no-causality wording", () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const repo = join(here, "..", "..", "..")
  const sources: Record<string, string> = {
    "apps/api/src/reobservations.ts": readFileSync(join(repo, "apps/api/src/reobservations.ts"), "utf8"),
    "apps/worker/src/check-runner.ts": readFileSync(join(repo, "apps/worker/src/check-runner.ts"), "utf8"),
    "packages/db/migrations/0012_reobservation_intents_v1.sql": readFileSync(
      join(repo, "packages/db/migrations/0012_reobservation_intents_v1.sql"),
      "utf8",
    ),
  }
  const banned = [
    "caused",
    "causes",
    "causing",
    "causality",
    "causation",
    "fixes the",
    "fixed the",
    "fixes an outcome",
    "improves",
    "improved",
    "proves",
    "proving",
    "root cause",
    "led to",
    "resulted in",
  ]

  for (const [file, text] of Object.entries(sources)) {
    it(`${file} never asserts what brought an outcome about`, () => {
      for (const word of banned) {
        expect(text.toLowerCase().includes(word), `${file} contains ${JSON.stringify(word)}`).toBe(false)
      }
    })
  }

  it("the migration stores linkage only: no outcome, match, or change columns", () => {
    const sql = sources["packages/db/migrations/0012_reobservation_intents_v1.sql"] as string
    // Column definitions (not comments about what is NOT stored) must never
    // carry derived measurements.
    for (const col of ["outcome", "match_classification", "observed_change", "causal_attribution"]) {
      const defined = new RegExp(`^\\s*${col}\\s+\\w+`, "im").test(sql) || new RegExp(`ADD COLUMN[^;]*\\b${col}\\b`, "is").test(sql)
      expect(defined, `migration defines column ${col}`).toBe(false)
    }
  })
})
