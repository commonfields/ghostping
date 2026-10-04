// Real-concurrency test for single-active recheck enforcement: two
// independent DB sessions racing enqueueReobservation on the same issue.
// Requires DATABASE_URL (skipped otherwise, like the other DB suites).
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import pg from "pg"
import { PgClient } from "@effect/sql-pg"
import {
  ReobservationIntentRepository,
  ReobservationIntentRepositoryLive,
} from "./evidence.js"
import { migrate } from "./migrate.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const run = url ? describe : describe.skip
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

type Repos = ReobservationIntentRepository

run("postgres re-observation single-active concurrency", () => {
  let pool: pg.Pool
  let scopeA: Scope.CloseableScope
  let scopeB: Scope.CloseableScope
  let ctxA: Context.Context<Repos>
  let ctxB: Context.Context<Repos>

  // Two fully independent sessions: separate PgClient layers (separate
  // pools), so concurrent transactions genuinely overlap on the server.
  const buildCtx = async () => {
    const scope = await Effect.runPromise(Scope.make())
    const live = Layer.provide(ReobservationIntentRepositoryLive, PgClient.layer({ url: Redacted.make(url) }))
    const ctx = await Effect.runPromise(Layer.buildWithScope(live, scope))
    return { scope, ctx }
  }

  beforeAll(async () => {
    await migrate(url)
    pool = new pg.Pool({ connectionString: url })
    const a = await buildCtx()
    scopeA = a.scope
    ctxA = a.ctx
    const b = await buildCtx()
    scopeB = b.scope
    ctxB = b.ctx
  })

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scopeA, Exit.succeed(undefined)))
    await Effect.runPromise(Scope.close(scopeB, Exit.succeed(undefined)))
    await pool.end()
  })

  const setupIssue = async () => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Acme') RETURNING id`, [accountId])).rows[0]["id"] as string
    const questionId = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'How much?') RETURNING id`, [businessId])).rows[0]["id"] as string
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, provider, status) VALUES ($1,$2,'mock','SUCCEEDED') RETURNING id`, [businessId, questionId])).rows[0]["id"] as string
    const rawId = (await pool.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') RETURNING id`, [unique("digest")])).rows[0]["id"] as string
    const obsId = (
      await pool.query(
        `INSERT INTO observations (business_id, check_run_id, provider, collected_at, answer_text, raw_evidence_id, raw_digest) VALUES ($1,$2,'mock',now(),'a',$3,$4) RETURNING id`,
        [businessId, runId, rawId, unique("digest")],
      )
    ).rows[0]["id"] as string
    const issueId = (await pool.query(`INSERT INTO candidate_claims (business_id, observation_id, text) VALUES ($1,$2,'a') RETURNING id`, [businessId, obsId])).rows[0]["id"] as string
    return { businessId, issueId, obsId }
  }

  const attempt = (ctx: Context.Context<Repos>, businessId: string, issueId: string, obsId: string) =>
    Effect.runPromiseExit(
      Effect.flatMap(ReobservationIntentRepository, (r) =>
        r.enqueueReobservation({ businessId, issueId, originalObservationId: obsId, interventionId: null, createdByUserId: USER }),
      ).pipe(Effect.provide(ctx)),
    )

  const tagOf = (exit: Exit.Exit<unknown, unknown>): string | null =>
    exit._tag === "Failure" && exit.cause._tag === "Fail"
      ? String((exit.cause.error as { _tag?: unknown })?._tag ?? null)
      : null

  it("same issue, simultaneous requests: exactly one commits", async () => {
    // Repeat to make a missing lock visible: without serialization the
    // pre-checks in both transactions observe no active attempt.
    for (let round = 0; round < 10; round++) {
      const s = await setupIssue()
      const [a, b] = await Promise.all([attempt(ctxA, s.businessId, s.issueId, s.obsId), attempt(ctxB, s.businessId, s.issueId, s.obsId)])
      const successes = [a, b].filter((e) => e._tag === "Success")
      const failures = [a, b].filter((e) => e._tag === "Failure")
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect(tagOf(failures[0]!)).toBe("ReobservationAlreadyActive")
      const n = (await pool.query(`SELECT count(*)::int AS n FROM reobservation_intents WHERE issue_id = $1`, [s.issueId])).rows[0]["n"] as number
      expect(n).toBe(1)
      const runs = (await pool.query(
        `SELECT count(*)::int AS n FROM check_runs cr JOIN reobservation_intents i ON i.check_run_id = cr.id WHERE i.issue_id = $1 AND cr.status IN ('QUEUED','RUNNING')`,
        [s.issueId],
      )).rows[0]["n"] as number
      expect(runs).toBe(1)
    }
  })

  it("different issues enqueue concurrently", async () => {
    const s1 = await setupIssue()
    const s2 = await setupIssue()
    const [a, b] = await Promise.all([
      attempt(ctxA, s1.businessId, s1.issueId, s1.obsId),
      attempt(ctxB, s2.businessId, s2.issueId, s2.obsId),
    ])
    expect(a._tag).toBe("Success")
    expect(b._tag).toBe("Success")
  })
})
