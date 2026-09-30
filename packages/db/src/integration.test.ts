// PostgreSQL closeout regression tests: atomic queue ownership, immutable
// raw-evidence dedupe, append-only judgments, guarded state transitions.
// Requires DATABASE_URL (CI provides a postgres service; skipped otherwise).
import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import pg from "pg"
import { PgClient } from "@effect/sql-pg"
import {
  CheckRunRepository,
  CheckRunRepositoryLive,
  JudgmentRepository,
  JudgmentRepositoryLive,
  ObservationRepository,
  ObservationRepositoryLive,
  RawDigestMismatch,
  type CheckRunRow,
} from "./repositories.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const run = url ? describe : describe.skip

const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

type ClaimFn = () => Effect.Effect<CheckRunRow | null, SqlError>

run("postgres closeout regressions", () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    await pool.query(`SELECT 1`)
  })
  afterAll(async () => {
    await pool.end()
  })

  // Build a repository layer bound to a FRESH pg pool and hold it open for
  // the test. Each env = one independent worker connection.
  const withRepos = async <A>(
    build: (ctx: Context.Context<CheckRunRepository | ObservationRepository | JudgmentRepository>) => A,
  ): Promise<{ scope: Scope.CloseableScope; value: A }> => {
    const scope = await Effect.runPromise(Scope.make())
    const PgLive = PgClient.layer({ url: Redacted.make(url) })
    const AllLive = Layer.mergeAll(CheckRunRepositoryLive, ObservationRepositoryLive, JudgmentRepositoryLive)
    const Provided = Layer.provide(AllLive, PgLive)
    const ctx = await Effect.runPromise(Layer.buildWithScope(Provided, scope))
    return { scope, value: build(ctx) }
  }
  const closeScope = (scope: Scope.CloseableScope) =>
    Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))

  const setupBusiness = async () => {
    const a = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const b = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'B') RETURNING id`, [a])).rows[0]["id"] as string
    const q = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'How much?') RETURNING id`, [b])).rows[0]["id"] as string
    return { a, b, q }
  }

  // Drain QUEUED rows left by prior tests so concurrency tests are exact.
  // Uses the real claim/finish path: DELETE would cascade into observations
  // and correctly trip the append-only trigger, so it is not used here.
  const drainQueue = async () => {
    const env = await withRepos((ctx) => Context.get(ctx, CheckRunRepository))
    try {
      for (;;) {
        const claimed = await Effect.runPromise(env.value.claimOne())
        if (!claimed) return
        await Effect.runPromise(env.value.markFinished(claimed.id, "FAILED", "UNKNOWN", "test drain"))
      }
    } finally {
      await closeScope(env.scope)
    }
  }

  const setupClaim = async () => {
    const { b, q } = await setupBusiness()
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'SUCCEEDED') RETURNING id`, [b, q])).rows[0]["id"] as string
    const rawId = (await pool.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') ON CONFLICT (digest) DO NOTHING RETURNING id`, [unique("cl")])).rows[0]["id"] as string
    const obsId = (await pool.query(
      `INSERT INTO observations (business_id, check_run_id, provider, collected_at, answer_text, retrieval_mode, raw_evidence_id, raw_digest) VALUES ($1,$2,'mock',now(),'a','unknown',$3,'d') RETURNING id`,
      [b, runId, rawId],
    )).rows[0]["id"] as string
    const claimId = (await pool.query(`INSERT INTO candidate_claims (business_id, observation_id, text) VALUES ($1,$2,'c') RETURNING id`, [b, obsId])).rows[0]["id"] as string
    return { b, claimId }
  }

  it("migrations create core tables (incl. attempt_count, judgment triggers)", async () => {
    const r = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('users','accounts','businesses','authoritative_facts','buyer_questions','check_runs','observations','raw_evidence','candidate_claims','human_judgments')`,
    )
    expect(r.rows.length).toBeGreaterThanOrEqual(10)
    const col = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'check_runs' AND column_name = 'attempt_count'`,
    )
    expect(col.rows.length).toBe(1)
    const superseded = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'human_judgments' AND column_name = 'superseded'`,
    )
    expect(superseded.rows.length).toBe(0)
    const t = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_observations_no_update','trg_raw_evidence_no_update','trg_human_judgments_no_update','trg_human_judgment_facts_no_update','trg_observation_citations_no_update')`,
    )
    expect(t.rows.length).toBe(5)
  })

  it("1 queued run + 2 simultaneous claimers = exactly 1 successful claim", async () => {
    await drainQueue()
    const { b, q } = await setupBusiness()
    await pool.query(`INSERT INTO check_runs (business_id, question_id) VALUES ($1,$2)`, [b, q])
    const e1 = await withRepos((ctx) => Context.get(ctx, CheckRunRepository))
    const e2 = await withRepos((ctx) => Context.get(ctx, CheckRunRepository))
    try {
      const [c1, c2] = await Promise.all([
        Effect.runPromise(e1.value.claimOne()),
        Effect.runPromise(e2.value.claimOne()),
      ])
      const wins = [c1, c2].filter((c) => c !== null)
      expect(wins).toHaveLength(1)
    } finally {
      await closeScope(e1.scope)
      await closeScope(e2.scope)
    }
  })

  it("50 queued runs + 8 concurrent claimers = 50 unique, 0 duplicates, 0 lost", async () => {
    await drainQueue()
    const { b, q } = await setupBusiness()
    for (let i = 0; i < 50; i++) {
      await pool.query(`INSERT INTO check_runs (business_id, question_id) VALUES ($1,$2)`, [b, q])
    }
    const envs = await Promise.all(
      Array.from({ length: 8 }, () => withRepos((ctx) => Context.get(ctx, CheckRunRepository))),
    )
    try {
      const claimed: Array<string> = []
      const worker = async (claimOne: ClaimFn) => {
        for (;;) {
          const got = await Effect.runPromise(claimOne())
          if (!got) return
          claimed.push(got.id)
        }
      }
      await Promise.all(envs.map((e) => worker(e.value.claimOne)))
      expect(claimed).toHaveLength(50)
      expect(new Set(claimed).size).toBe(50)
      const remaining = await pool.query(`SELECT count(*) FROM check_runs WHERE status = 'QUEUED'`)
      expect(Number(remaining.rows[0]["count"])).toBe(0)
    } finally {
      await Promise.all(envs.map((e) => closeScope(e.scope)))
    }
  })

  it("state transitions are guarded in SQL (no SUCCEEDED->RUNNING, no double finish)", async () => {
    await drainQueue()
    const { b, q } = await setupBusiness()
    const id = (await pool.query(`INSERT INTO check_runs (business_id, question_id) VALUES ($1,$2) RETURNING id`, [b, q])).rows[0]["id"] as string
    const env = await withRepos((ctx) => Context.get(ctx, CheckRunRepository))
    try {
      const first = await Effect.runPromise(env.value.claimOne())
      expect(first).not.toBeNull()
      // Terminal rows cannot be re-opened or re-finished via normal methods.
      await Effect.runPromise(env.value.markFinished(id, "SUCCEEDED", null, null))
      await Effect.runPromise(env.value.markFinished(id, "FAILED", "UNKNOWN", "late"))
      await Effect.runPromise(env.value.markRunning(id))
      const row = (await pool.query(`SELECT status, failure_class FROM check_runs WHERE id = $1`, [id])).rows[0]
      expect(row["status"]).toBe("SUCCEEDED")
      expect(row["failure_class"]).toBeNull()
    } finally {
      await closeScope(env.scope)
    }
  })

  it("identical raw evidence deduplicates: 2 observations, 1 raw_evidence row, 0 mutations", async () => {
    const { b, q } = await setupBusiness()
    const env = await withRepos((ctx) => Context.get(ctx, ObservationRepository))
    try {
      const digest = `dedup-${unique("d")}`
      const rawResponse = { provider: "mock", answer: "Northstar costs $29/month." }
      const mkRun = () =>
        pool.query(`INSERT INTO check_runs (business_id, question_id) VALUES ($1,$2) RETURNING id`, [b, q]).then((r) => r.rows[0]["id"] as string)
      const r1 = await mkRun()
      const r2 = await mkRun()
      const base = {
        businessId: b,
        provider: "mock",
        requestedModel: null,
        observedModel: "mock-v1",
        collectedAt: new Date().toISOString(),
        answerText: "Northstar costs $29/month.",
        retrievalMode: "unknown",
        rawResponse,
        rawDigest: digest,
        citations: [],
      }
      const o1 = await Effect.runPromise(env.value.create({ ...base, checkRunId: r1 }))
      const o2 = await Effect.runPromise(env.value.create({ ...base, checkRunId: r2 }))
      expect(o1.rawEvidenceId).toBe(o2.rawEvidenceId)
      expect(o1.id).not.toBe(o2.id)
      const count = await pool.query(`SELECT count(*) FROM raw_evidence WHERE digest = $1`, [digest])
      expect(Number(count.rows[0]["count"])).toBe(1)
    } finally {
      await closeScope(env.scope)
    }
  })

  it("same digest + different content fails closed and preserves the original", async () => {
    const { b, q } = await setupBusiness()
    const env = await withRepos((ctx) => Context.get(ctx, ObservationRepository))
    try {
      const digest = `collision-${unique("d")}`
      const r1 = (await pool.query(`INSERT INTO check_runs (business_id, question_id) VALUES ($1,$2) RETURNING id`, [b, q])).rows[0]["id"] as string
      const r2 = (await pool.query(`INSERT INTO check_runs (business_id, question_id) VALUES ($1,$2) RETURNING id`, [b, q])).rows[0]["id"] as string
      const base = {
        businessId: b,
        provider: "mock",
        requestedModel: null,
        observedModel: "mock-v1",
        collectedAt: new Date().toISOString(),
        answerText: "a",
        retrievalMode: "unknown",
        citations: [],
      }
      await Effect.runPromise(env.value.create({ ...base, checkRunId: r1, rawResponse: { v: 1 }, rawDigest: digest }))
      const exit = await Effect.runPromiseExit(env.value.create({ ...base, checkRunId: r2, rawResponse: { v: 2 }, rawDigest: digest }))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(RawDigestMismatch)
      }
      const row = (await pool.query(`SELECT content_text FROM raw_evidence WHERE digest = $1`, [digest])).rows[0]
      expect(row["content_text"]).toBe(JSON.stringify({ v: 1 }))
    } finally {
      await closeScope(env.scope)
    }
  })

  it("raw_evidence UPDATE and DELETE are rejected", async () => {
    const digest = `frozen-${unique("d")}`
    await pool.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') ON CONFLICT (digest) DO NOTHING`, [digest])
    await expect(pool.query(`UPDATE raw_evidence SET content_text = '{}' WHERE digest = $1`, [digest])).rejects.toThrow()
    await expect(pool.query(`DELETE FROM raw_evidence WHERE digest = $1`, [digest])).rejects.toThrow()
  })

  it("judgments form an append-only chain; old rows never mutate; UPDATE/DELETE rejected", async () => {
    const { b, claimId } = await setupClaim()
    const env = await withRepos((ctx) => Context.get(ctx, JudgmentRepository))
    try {
      const j1 = await Effect.runPromise(env.value.create({ businessId: b, claimId, verdict: "CONTRADICTED", notes: null, factIds: [] }))
      expect(j1.supersedesId).toBeNull()
      const before = await pool.query(`SELECT * FROM human_judgments WHERE id = $1`, [j1.id])
      const j2 = await Effect.runPromise(env.value.create({ businessId: b, claimId, verdict: "SUPPORTED", notes: null, factIds: [] }))
      expect(j2.supersedesId).toBe(j1.id)
      const j3 = await Effect.runPromise(env.value.create({ businessId: b, claimId, verdict: "PARTIAL", notes: null, factIds: [] }))
      expect(j3.supersedesId).toBe(j2.id)
      // Old rows byte-for-byte unchanged.
      const after = await pool.query(`SELECT * FROM human_judgments WHERE id = $1`, [j1.id])
      expect(after.rows[0]).toEqual(before.rows[0])
      const after2 = await pool.query(`SELECT * FROM human_judgments WHERE id = $1`, [j2.id])
      expect(String(after2.rows[0]["supersedes_id"])).toBe(String(j1.id))
      // Head + history.
      const head = await Effect.runPromise(env.value.latestForClaim(claimId))
      expect(head?.id).toBe(j3.id)
      const history = await Effect.runPromise(env.value.listByClaim(claimId))
      expect(history).toHaveLength(3)
      // Immutability enforced in the database.
      await expect(pool.query(`UPDATE human_judgments SET notes = 'x' WHERE id = $1`, [j1.id])).rejects.toThrow()
      await expect(pool.query(`DELETE FROM human_judgments WHERE id = $1`, [j1.id])).rejects.toThrow()
    } finally {
      await closeScope(env.scope)
    }
  })

  it("two concurrent judgments on one claim form one linear chain, never two heads", async () => {
    const { b, claimId } = await setupClaim()
    const e1 = await withRepos((ctx) => Context.get(ctx, JudgmentRepository))
    const e2 = await withRepos((ctx) => Context.get(ctx, JudgmentRepository))
    try {
      const [j1, j2] = await Promise.all([
        Effect.runPromise(e1.value.create({ businessId: b, claimId, verdict: "SUPPORTED", notes: "a", factIds: [] })),
        Effect.runPromise(e2.value.create({ businessId: b, claimId, verdict: "CONTRADICTED", notes: "b", factIds: [] })),
      ])
      expect(new Set([j1.id, j2.id]).size).toBe(2)
      // Exactly one head; the later insert points at the earlier one.
      const heads = await pool.query(
        `SELECT id FROM human_judgments j WHERE j.claim_id = $1 AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id)`,
        [claimId],
      )
      expect(heads.rows).toHaveLength(1)
      const rows = await pool.query(`SELECT id, supersedes_id FROM human_judgments WHERE claim_id = $1`, [claimId])
      expect(rows.rows).toHaveLength(2)
      expect(rows.rows.filter((r) => r["supersedes_id"] === null)).toHaveLength(1)
      const head = await Effect.runPromise(e1.value.latestForClaim(claimId))
      expect(head?.id).toBe(heads.rows[0]["id"])
    } finally {
      await closeScope(e1.scope)
      await closeScope(e2.scope)
    }
  })
})
