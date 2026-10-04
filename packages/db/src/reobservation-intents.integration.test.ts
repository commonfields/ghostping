// PostgreSQL 16 integration tests for durable re-observation intents:
// append-only intents with database-enforced tenancy, idempotent link
// finalization (two completions, one link), sweep recovery for SUCCEEDED
// runs with unfulfilled intents, and the guarantee that FAILED checks
// never produce re-observation rows. Requires DATABASE_URL (skipped
// otherwise, like the other DB suites).
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import pg from "pg"
import { PgClient } from "@effect/sql-pg"
import { ObservationRepository, ObservationRepositoryLive } from "./repositories.js"
import {
  EvidenceLineageRepository,
  EvidenceLineageRepositoryLive,
  hostedMeasurementContext,
  InterventionRepository,
  InterventionRepositoryLive,
  ReobservationIntentRepository,
  ReobservationIntentRepositoryLive,
  ReobservationRepository,
  ReobservationRepositoryLive,
  type InterventionInput,
} from "./evidence.js"
import { migrate } from "./migrate.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const run = url ? describe : describe.skip
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

type Repos =
  | ObservationRepository
  | InterventionRepository
  | ReobservationRepository
  | ReobservationIntentRepository
  | EvidenceLineageRepository

run("postgres re-observation intents v1", () => {
  let pool: pg.Pool
  let scope: Scope.CloseableScope
  let ctx: Context.Context<Repos>
  const runFx = <A, E>(fx: Effect.Effect<A, E, Repos>) => Effect.runPromise(Effect.provide(fx, ctx))

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    scope = await Effect.runPromise(Scope.make())
    const live = Layer.provide(
      Layer.mergeAll(
        ObservationRepositoryLive,
        InterventionRepositoryLive,
        ReobservationRepositoryLive,
        ReobservationIntentRepositoryLive,
        EvidenceLineageRepositoryLive,
      ),
      PgClient.layer({ url: Redacted.make(url) }),
    )
    ctx = await Effect.runPromise(Layer.buildWithScope(live, scope))
  })
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await pool.end()
  })

  const QUESTION = "How much does Acme Starter cost?"

  const setupBusiness = async () => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Acme') RETURNING id`, [accountId])).rows[0]["id"] as string
    const questionId = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,$2) RETURNING id`, [businessId, QUESTION])).rows[0]["id"] as string
    return { accountId, businessId, questionId }
  }

  const observe = async (biz: { businessId: string; questionId: string }, answer: string, collectedAt: string) => {
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'SUCCEEDED') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
    const raw = { answer, run: runId }
    const bytes = JSON.stringify(raw)
    const context = hostedMeasurementContext({
      businessId: biz.businessId, questionId: biz.questionId, checkRunId: runId, prompt: QUESTION,
      provider: "mock", requestedModel: null, observedModel: null, observedAt: collectedAt,
    })
    const obs = await runFx(Effect.flatMap(ObservationRepository, (r) => r.create({
      businessId: biz.businessId, checkRunId: runId, provider: "mock", requestedModel: null, observedModel: null,
      collectedAt, answerText: answer, retrievalMode: "unknown", rawResponse: raw, rawDigest: sha(bytes),
      rawBytesHex: Buffer.from(bytes).toString("hex"), rawContentType: "application/json", providerMetadata: { synthetic: true },
      surfaceIdentity: context.surface, measurementContext: context, synthetic: true, citations: [],
    })))
    return { observationId: obs.id, runId }
  }
  const claim = async (businessId: string, observationId: string, text: string) =>
    (await pool.query(`INSERT INTO candidate_claims (business_id, observation_id, text, origin) VALUES ($1,$2,$3,'MANUAL_EXACT_SPAN') RETURNING id`, [businessId, observationId, text])).rows[0]["id"] as string
  const intervention = (businessId: string, issueIds: Array<string>): InterventionInput => ({
    businessId, issueIds, type: "SOURCE_UPDATED", target: "https://acme.example/pricing", performedAt: "2026-10-01T12:00:00.000Z",
    actor: "HUMAN", actorId: null, notes: null, evidenceBeforeDigest: null, evidenceAfterDigest: null,
    supersedesId: null, correctionReason: null,
  })
  const intent = (input: {
    businessId: string
    issueId: string
    originalObservationId: string
    interventionId: string | null
    checkRunId: string
  }) =>
    runFx(Effect.flatMap(ReobservationIntentRepository, (r) => r.createIntent({ ...input, createdByUserId: USER })))
  const finalize = (checkRunId: string) =>
    runFx(Effect.flatMap(ObservationRepository, (r) => r.finalizeReobservationForCheckRun(checkRunId)))
  const sweep = (limit = 25) =>
    runFx(Effect.flatMap(ObservationRepository, (r) => r.sweepUnfulfilledReobservations(limit)))

  it("migration 0012 re-runs cleanly and stores linkage only", async () => {
    await migrate(url)
    await migrate(url)
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'reobservation_intents'`,
    )
    const names = cols.rows.map((r) => r["column_name"] as string)
    for (const expected of ["business_id", "issue_id", "original_observation_id", "intervention_id", "check_run_id", "created_by_user_id", "created_at"]) {
      expect(names).toContain(expected)
    }
    for (const banned of ["outcome", "match_classification", "observed_change", "causal_attribution", "status"]) {
      expect(names).not.toContain(banned)
    }
    const triggers = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_reobservation_intents_tenancy','trg_reobservation_intents_no_update','trg_reobservation_intents_no_truncate') AND NOT tgisinternal`,
    )
    expect(triggers.rows).toHaveLength(3)
  })

  it("intents are append-only", async () => {
    const biz = await setupBusiness()
    const before = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
    const issueId = await claim(biz.businessId, before.observationId, "$29/month")
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'QUEUED') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
    const created = await intent({ businessId: biz.businessId, issueId, originalObservationId: before.observationId, interventionId: null, checkRunId: runId })
    expect(created).not.toBeNull()
    await expect(pool.query(`UPDATE reobservation_intents SET intervention_id = NULL WHERE id = $1`, [created!.id])).rejects.toThrow(/append-only/)
    await expect(pool.query(`DELETE FROM reobservation_intents WHERE id = $1`, [created!.id])).rejects.toThrow(/append-only/)
  })

  it("rejects cross-tenant intents and mismatched lineage with typed errors", async () => {
    const a = await setupBusiness()
    const b = await setupBusiness()
    const aObs = await observe(a, "$29/month", "2026-10-01T00:00:00.000Z")
    const bObs = await observe(b, "$29/month", "2026-10-01T00:00:00.000Z")
    const aIssue = await claim(a.businessId, aObs.observationId, "$29/month")
    const bIssue = await claim(b.businessId, bObs.observationId, "$29/month")
    const queuedA = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'QUEUED') RETURNING id`, [a.businessId, a.questionId])).rows[0]["id"] as string
    // Cross-tenant issue: null (404 upstream), nothing stored.
    expect(await intent({ businessId: b.businessId, issueId: aIssue, originalObservationId: aObs.observationId, interventionId: null, checkRunId: queuedA })).toBeNull()
    expect((await pool.query(`SELECT count(*)::int AS n FROM reobservation_intents WHERE check_run_id = $1`, [queuedA])).rows[0]["n"]).toBe(0)
    // Original observation from another issue lineage: typed mismatch.
    const otherClaim = await claim(a.businessId, aObs.observationId, "other words")
    const wrongOriginal = await Effect.runPromiseExit(
      Effect.flatMap(ReobservationIntentRepository, (r) =>
        r.createIntent({ businessId: a.businessId, issueId: otherClaim, originalObservationId: bObs.observationId, interventionId: null, checkRunId: queuedA, createdByUserId: USER }),
      ).pipe((fx) => Effect.provide(fx, ctx)),
    )
    expect(Exit.isFailure(wrongOriginal)).toBe(true)
    // Unrelated intervention: typed mismatch, and the database trigger
    // agrees when bypassing the repository.
    const unrelated = await runFx(Effect.flatMap(InterventionRepository, (r) => r.append(intervention(a.businessId, [otherClaim]))))
    const badLink = await Effect.runPromiseExit(
      Effect.flatMap(ReobservationIntentRepository, (r) =>
        r.createIntent({ businessId: a.businessId, issueId: aIssue, originalObservationId: aObs.observationId, interventionId: unrelated.id, checkRunId: queuedA, createdByUserId: USER }),
      ).pipe((fx) => Effect.provide(fx, ctx)),
    )
    expect(Exit.isFailure(badLink)).toBe(true)
    await expect(pool.query(
      `INSERT INTO reobservation_intents (business_id, issue_id, original_observation_id, intervention_id, check_run_id, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.businessId, aIssue, aObs.observationId, unrelated.id, queuedA, USER],
    )).rejects.toThrow(/not linked to issue/)
    // Cross-tenant intervention: also a mismatch, never a link.
    const bIntervention = await runFx(Effect.flatMap(InterventionRepository, (r) => r.append(intervention(b.businessId, [bIssue]))))
    expect(Exit.isFailure(await Effect.runPromiseExit(
      Effect.flatMap(ReobservationIntentRepository, (r) =>
        r.createIntent({ businessId: a.businessId, issueId: aIssue, originalObservationId: aObs.observationId, interventionId: bIntervention.id, checkRunId: queuedA, createdByUserId: USER }),
      ).pipe((fx) => Effect.provide(fx, ctx)),
    ))).toBe(true)
  })

  it("two completions yield one link, concurrently or sequentially", async () => {
    const biz = await setupBusiness()
    const before = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
    const issueId = await claim(biz.businessId, before.observationId, "$29/month")
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'QUEUED') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
    await intent({ businessId: biz.businessId, issueId, originalObservationId: before.observationId, interventionId: null, checkRunId: runId })
    // Complete the run through the worker path (observation completion
    // finalizes the link in the same transaction).
    await pool.query(`UPDATE check_runs SET status = 'RUNNING' WHERE id = $1`, [runId])
    const bytes = JSON.stringify({ answer: "$39/month", run: runId })
    const context = hostedMeasurementContext({
      businessId: biz.businessId, questionId: biz.questionId, checkRunId: runId, prompt: QUESTION,
      provider: "mock", requestedModel: null, observedModel: null, observedAt: "2026-10-02T00:00:00.000Z",
    })
    await runFx(Effect.flatMap(ObservationRepository, (r) => r.create({
      businessId: biz.businessId, checkRunId: runId, provider: "mock", requestedModel: null, observedModel: null,
      collectedAt: "2026-10-02T00:00:00.000Z", answerText: "$39/month", retrievalMode: "unknown",
      rawResponse: { answer: "$39/month", run: runId }, rawDigest: sha(bytes),
      rawBytesHex: Buffer.from(bytes).toString("hex"), rawContentType: "application/json", providerMetadata: { synthetic: true },
      surfaceIdentity: context.surface, measurementContext: context, synthetic: true, citations: [], completeRun: true,
    })))
    // The atomic inclusion already linked it; concurrent and sequential
    // repeats return the same single winner.
    const [first, second] = await Promise.all([finalize(runId), finalize(runId)])
    expect(first?.id).toBeDefined()
    expect(second?.id).toBe(first?.id)
    const third = await finalize(runId)
    expect(third?.id).toBe(first?.id)
    expect((await pool.query(`SELECT count(*)::int AS n FROM reobservations WHERE issue_id = $1`, [issueId])).rows[0]["n"]).toBe(1)
    // The intent resolves by check run for the worker.
    const resolved = await runFx(Effect.flatMap(ReobservationIntentRepository, (r) => r.resolveIntent(runId)))
    expect(resolved?.checkRunId).toBe(runId)
  })

  it("sweeps SUCCEEDED runs with unfulfilled intents and ignores the rest", async () => {
    const biz = await setupBusiness()
    const before = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
    const issueId = await claim(biz.businessId, before.observationId, "$29/month")
    // Intent recorded against an already-collected observation (the crash
    // window: completion committed without a link).
    const after = await observe(biz, "$39/month", "2026-10-02T00:00:00.000Z")
    await intent({ businessId: biz.businessId, issueId, originalObservationId: before.observationId, interventionId: null, checkRunId: after.runId })
    // A FAILED run with an intent is never swept into a link.
    const failedRunId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status, failure_class) VALUES ($1,$2,'FAILED','PROVIDER_TIMEOUT') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
    await intent({ businessId: biz.businessId, issueId, originalObservationId: before.observationId, interventionId: null, checkRunId: failedRunId })
    expect(await sweep()).toBe(1)
    expect((await pool.query(`SELECT count(*)::int AS n FROM reobservations WHERE issue_id = $1`, [issueId])).rows[0]["n"]).toBe(1)
    // Drained: a second sweep finds nothing new.
    expect(await sweep()).toBe(0)
    // The failed run produced no lineage row.
    expect((await pool.query(
      `SELECT count(*)::int AS n FROM reobservations r JOIN observations o ON o.id = r.observation_id WHERE o.check_run_id = $1`,
      [failedRunId],
    )).rows[0]["n"]).toBe(0)
  })

  it("failed checks never create re-observation rows", async () => {    const biz = await setupBusiness()
    const before = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
    const issueId = await claim(biz.businessId, before.observationId, "$29/month")
    const failedRunId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status, failure_class) VALUES ($1,$2,'FAILED','PROVIDER_TIMEOUT') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
    await intent({ businessId: biz.businessId, issueId, originalObservationId: before.observationId, interventionId: null, checkRunId: failedRunId })
    expect(await finalize(failedRunId)).toBeNull()
    expect((await pool.query(`SELECT count(*)::int AS n FROM reobservations WHERE issue_id = $1`, [issueId])).rows[0]["n"]).toBe(0)
  })

  describe("atomic recheck creation", () => {
    const atomic = (businessId: string, issueId: string, originalObservationId: string, interventionId: string | null) =>
      runFx(Effect.flatMap(ReobservationIntentRepository, (r) =>
        r.enqueueReobservation({ businessId, issueId, originalObservationId, interventionId, createdByUserId: USER })))

    it("success commits one CheckRun and one intent repeating the original identity", async () => {
      const biz = await setupBusiness()
      const before = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
      const issueId = await claim(biz.businessId, before.observationId, "$29/month")
      const created = await atomic(biz.businessId, issueId, before.observationId, null)
      expect(created).not.toBeNull()
      expect(created?.intent.checkRunId).toBe(created?.checkRun.id)
      const run = (await pool.query(`SELECT question_id, provider, requested_model FROM check_runs WHERE id = $1`, [created!.checkRun.id])).rows[0]
      const orig = (await pool.query(`SELECT question_id, provider, requested_model FROM check_runs WHERE id = $1`, [before.runId])).rows[0]
      expect({ q: run["question_id"], p: run["provider"], m: run["requested_model"] }).toEqual({ q: orig["question_id"], p: orig["provider"], m: orig["requested_model"] })
      expect(created?.checkRun.status).toBe("QUEUED")
    })

    it("intent validation failure commits neither run nor intent", async () => {
      const biz = await setupBusiness()
      const before = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
      const issueId = await claim(biz.businessId, before.observationId, "$29/month")
      const otherClaim = await claim(biz.businessId, before.observationId, "other words")
      const unrelated = await runFx(Effect.flatMap(InterventionRepository, (r) => r.append(intervention(biz.businessId, [otherClaim]))))
      const runsBefore = (await pool.query(`SELECT count(*)::int AS n FROM check_runs WHERE business_id = $1`, [biz.businessId])).rows[0]["n"] as number
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ReobservationIntentRepository, (r) =>
          r.enqueueReobservation({ businessId: biz.businessId, issueId, originalObservationId: before.observationId, interventionId: unrelated.id, createdByUserId: USER }),
        ).pipe((fx) => Effect.provide(fx, ctx)),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect((await pool.query(`SELECT count(*)::int AS n FROM check_runs WHERE business_id = $1`, [biz.businessId])).rows[0]["n"]).toBe(runsBefore)
      expect((await pool.query(`SELECT count(*)::int AS n FROM reobservation_intents WHERE issue_id = $1`, [issueId])).rows[0]["n"]).toBe(0)
    })

    it("a second active attempt fails typed; terminal attempts do not block", async () => {
      const biz = await setupBusiness()
      const before = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
      const issueId = await claim(biz.businessId, before.observationId, "$29/month")
      const first = await atomic(biz.businessId, issueId, before.observationId, null)
      expect(first).not.toBeNull()
      const dup = await Effect.runPromiseExit(
        Effect.flatMap(ReobservationIntentRepository, (r) =>
          r.enqueueReobservation({ businessId: biz.businessId, issueId, originalObservationId: before.observationId, interventionId: null, createdByUserId: USER }),
        ).pipe((fx) => Effect.provide(fx, ctx)),
      )
      expect(Exit.isFailure(dup)).toBe(true)
      if (dup._tag === "Failure" && dup.cause._tag === "Fail") {
        expect(String((dup.cause.error as { _tag?: string })?._tag)).toBe("ReobservationAlreadyActive")
      }
      expect((await pool.query(`SELECT count(*)::int AS n FROM reobservation_intents WHERE issue_id = $1`, [issueId])).rows[0]["n"]).toBe(1)
      await pool.query(`UPDATE check_runs SET status = 'SUCCEEDED', completed_at = now() WHERE id = $1`, [first!.checkRun.id])
      const second = await atomic(biz.businessId, issueId, before.observationId, null)
      expect(second).not.toBeNull()
      expect(second?.checkRun.id).not.toBe(first?.checkRun.id)
    })
  })

  describe("measurement identity backstop", () => {
    const directIntent = (businessId: string, issueId: string, originalObservationId: string, checkRunId: string) =>
      pool.query(
        `INSERT INTO reobservation_intents (business_id, issue_id, original_observation_id, check_run_id, created_by_user_id) VALUES ($1,$2,$3,$4,$5)`,
        [businessId, issueId, originalObservationId, checkRunId, USER],
      )

    it("direct writes with mismatched question/provider/model are rejected", async () => {
      const biz = await setupBusiness()
      const before = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
      const issueId = await claim(biz.businessId, before.observationId, "$29/month")
      const otherQuestion = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'Other question') RETURNING id`, [biz.businessId])).rows[0]["id"] as string
      const badQuestion = (await pool.query(`INSERT INTO check_runs (business_id, question_id, provider, status) VALUES ($1,$2,'mock','QUEUED') RETURNING id`, [biz.businessId, otherQuestion])).rows[0]["id"] as string
      await expect(directIntent(biz.businessId, issueId, before.observationId, badQuestion)).rejects.toThrow(/different question/)
      const badProvider = (await pool.query(`INSERT INTO check_runs (business_id, question_id, provider, status) VALUES ($1,$2,'9router','QUEUED') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
      await expect(directIntent(biz.businessId, issueId, before.observationId, badProvider)).rejects.toThrow(/different provider/)
      const badModel = (await pool.query(`INSERT INTO check_runs (business_id, question_id, provider, requested_model, status) VALUES ($1,$2,'mock','model-x','QUEUED') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
      await expect(directIntent(biz.businessId, issueId, before.observationId, badModel)).rejects.toThrow(/different requested model/)
      const otherBiz = await setupBusiness()
      const foreignRun = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'QUEUED') RETURNING id`, [otherBiz.businessId, otherBiz.questionId])).rows[0]["id"] as string
      await expect(directIntent(biz.businessId, issueId, before.observationId, foreignRun)).rejects.toThrow()
      const goodRun = (await pool.query(`INSERT INTO check_runs (business_id, question_id, provider, status) VALUES ($1,$2,'mock','QUEUED') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
      await directIntent(biz.businessId, issueId, before.observationId, goodRun)
      expect((await pool.query(`SELECT count(*)::int AS n FROM reobservation_intents WHERE check_run_id = $1`, [goodRun])).rows[0]["n"]).toBe(1)
    })
  })
})
