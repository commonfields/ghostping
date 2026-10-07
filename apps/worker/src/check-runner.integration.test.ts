import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, Redacted, Schedule } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { CheckRunRepository, CheckRunRepositoryLive, ObservationRepository, ObservationRepositoryLive, ProviderAttemptEvidenceRepository, ProviderAttemptEvidenceRepositoryLive, QuestionRepositoryLive } from "@openrecord/db"
import { MockProviderLive, NineRouterProvider, ProviderRegistryLive, ProviderUnsupported, rawEvidence } from "@openrecord/providers"
import { CheckRunner, makeCheckRunnerLive } from "./check-runner.js"
const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("Effect provider cutover persistence", () => {
  let pool: pg.Pool
  const PgLive = PgClient.layer({ url: Redacted.make(url) })
  const Repos = Layer.mergeAll(CheckRunRepositoryLive, QuestionRepositoryLive, ObservationRepositoryLive, ProviderAttemptEvidenceRepositoryLive).pipe(Layer.provide(PgLive))
  const Providers = ProviderRegistryLive.pipe(Layer.provide(MockProviderLive), Layer.provide(Layer.succeed(NineRouterProvider, { observe: () => Effect.fail(new ProviderUnsupported({})) })))
  const Runner = makeCheckRunnerLive(Schedule.recurs(3)).pipe(Layer.provide(Repos), Layer.provide(Providers))
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    await pool.query("SELECT 1")
    // Other integration suites leave queued fixtures; drain via legal state
    // transitions so the worker's oldest-first claim tests are deterministic.
    await Effect.runPromise(Effect.gen(function*() {
      const runs = yield* CheckRunRepository
      for (;;) {
        const run = yield* runs.claimOne()
        if (!run) break
        yield* runs.markFinished(run.id, "FAILED", "UNKNOWN", "test fixture drain")
      }
    }).pipe(Effect.provide(Repos)))
  })
  afterAll(async () => { await pool.end() })
  const fixture = async (prompt: string) => {
    const account = (await pool.query("INSERT INTO accounts (name) VALUES ('Effect runtime fixture') RETURNING id")).rows[0].id as string
    const business = (await pool.query("INSERT INTO businesses (account_id, name) VALUES ($1,'Fixture') RETURNING id", [account])).rows[0].id as string
    const question = (await pool.query("INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,$2) RETURNING id", [business, prompt])).rows[0].id as string
    const run = (await pool.query("INSERT INTO check_runs (business_id, question_id, provider) VALUES ($1,$2,'mock') RETURNING id", [business, question])).rows[0].id as string
    return { business, run }
  }
  const runOnce = () => Effect.runPromise(Effect.gen(function*() { return yield* (yield* CheckRunner).runOnce() }).pipe(Effect.provide(Runner)))
  it("claims and atomically persists synthetic success with exact evidence", async () => {
    const f = await fixture("__wrong__")
    await runOnce()
    const row = (await pool.query(`SELECT cr.status, cr.attempt_count, o.synthetic, o.answer_text, r.digest, r.raw_bytes_hex, r.response_max_bytes
      FROM check_runs cr JOIN observations o ON o.check_run_id=cr.id JOIN raw_evidence r ON r.id=o.raw_evidence_id WHERE cr.id=$1`, [f.run])).rows[0]
    expect(row.status).toBe("SUCCEEDED")
    expect(row.attempt_count).toBe(1)
    expect(row.synthetic).toBe(true)
    expect(row.answer_text).toBe("Northstar costs $29/month.")
    expect(rawEvidence(Buffer.from(row.raw_bytes_hex, "hex"), null).rawDigest).toBe(row.digest)
    expect(row.response_max_bytes).toBe(2 * 1024 * 1024)
    expect((await pool.query("SELECT count(*)::int n FROM observation_citations c JOIN observations o ON o.id=c.observation_id WHERE o.check_run_id=$1", [f.run])).rows[0].n).toBe(0)
  })
  it("persists all four failed attempts; failed runs produce no observations", async () => {
    const f = await fixture("__fail__")
    await runOnce()
    const run = (await pool.query("SELECT status, failure_class, failure_detail_safe, attempt_count FROM check_runs WHERE id=$1", [f.run])).rows[0]
    expect(run.status).toBe("FAILED")
    expect(run.attempt_count).toBe(4)
    expect(run.failure_class).toBe("PROVIDER_UNAVAILABLE")
    expect(run.failure_detail_safe).not.toContain("__fail__")
    const evidence = (await pool.query("SELECT * FROM provider_attempt_evidence WHERE check_run_id=$1 ORDER BY attempt", [f.run])).rows
    expect(evidence).toHaveLength(4)
    for (const row of evidence) expect(rawEvidence(Buffer.from(row.raw_bytes_hex, "hex"), null).rawDigest).toBe(row.digest)
    expect((await pool.query("SELECT count(*)::int n FROM observations WHERE check_run_id=$1", [f.run])).rows[0].n).toBe(0)
    await expect(pool.query("UPDATE provider_attempt_evidence SET failure_class='UNKNOWN' WHERE check_run_id=$1", [f.run])).rejects.toThrow()
    await expect(pool.query("DELETE FROM provider_attempt_evidence WHERE check_run_id=$1", [f.run])).rejects.toThrow()
  })
  it("failed citation insertion rolls back raw evidence, observation, and completion", async () => {
    const f = await fixture("rollback")
    await pool.query("UPDATE check_runs SET status='RUNNING' WHERE id=$1", [f.run])
    const bytes = new TextEncoder().encode(`rollback-${f.run}`)
    const raw = rawEvidence(bytes, null)
    const result = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* ObservationRepository).create({ businessId: f.business, checkRunId: f.run, provider: "mock", requestedModel: null, observedModel: null,
        collectedAt: new Date().toISOString(), answerText: "fixture", retrievalMode: "unknown", rawResponse: {}, rawDigest: raw.rawDigest,
        rawBytesHex: Buffer.from(bytes).toString("hex"), rawContentType: null, completeRun: true,
        citations: [{ uri: null, title: null, position: 1.5, attributed: false }] })
    }).pipe(Effect.provide(Repos), Effect.either))
    expect(result._tag).toBe("Left")
    expect((await pool.query("SELECT status FROM check_runs WHERE id=$1", [f.run])).rows[0].status).toBe("RUNNING")
    expect((await pool.query("SELECT count(*)::int n FROM observations WHERE check_run_id=$1", [f.run])).rows[0].n).toBe(0)
    expect((await pool.query("SELECT count(*)::int n FROM raw_evidence WHERE digest=$1", [raw.rawDigest])).rows[0].n).toBe(0)
  })
  it("failure evidence cannot cross business ownership or bypass digest checks", async () => {
    const f = await fixture("tenant")
    const other = await fixture("other-tenant")
    await pool.query("UPDATE check_runs SET status='RUNNING' WHERE id=ANY($1::uuid[])", [[f.run, other.run]])
    const raw = rawEvidence(new Uint8Array([1, 2, 3]), null)
    for (const [businessId, digest] of [[other.business, raw.rawDigest], [f.business, "0".repeat(64)]]) {
      const result = await Effect.runPromise(Effect.gen(function*() {
        return yield* (yield* ProviderAttemptEvidenceRepository).record({ checkRunId: f.run, businessId: businessId!, attempt: 1, failureClass: "PROVIDER_AUTH", status: 401,
          bytes: raw.rawBytes, digest: digest!, contentType: null, responseMaxBytes: 2048 })
      }).pipe(Effect.provide(Repos), Effect.either))
      expect(result._tag).toBe("Left")
    }
    expect((await pool.query("SELECT count(*)::int n FROM provider_attempt_evidence WHERE check_run_id=$1", [f.run])).rows[0].n).toBe(0)
  })
})
