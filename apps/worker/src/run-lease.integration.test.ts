// Abandoned RUNNING recovery: a worker that dies after claiming a check must
// not leave the run RUNNING (and its assay group QUEUED) forever, and
// recovery must never issue a provider call on its own.
// Requires TEST_DATABASE_URL (CI provides postgres; skipped otherwise).
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Redacted, Schedule } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import {
  AssayRepository, AssayRepositoryLive, CheckRunRepository, CheckRunRepositoryLive, ObservationRepositoryLive,
  ProviderAttemptEvidenceRepositoryLive, QuestionRepositoryLive, type AssayGroupRow,
} from "@openrecord/db"
import { makeMockProviderLive, NineRouterProvider, ProviderRegistryLive, ProviderUnsupported, type ProviderRequest } from "@openrecord/providers"
import { CheckRunner, makeCheckRunnerLive } from "./check-runner.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("abandoned RUNNING recovery (worker lease)", () => {
  let pool: pg.Pool
  /** Every provider request the runner makes, by check run id. */
  const providerCalls: string[] = []
  const script = (request: ProviderRequest) => {
    providerCalls.push(request.runId)
    return "Northstar costs $49 flat per month."
  }
  const PgLive = PgClient.layer({ url: Redacted.make(url) })
  const Repos = Layer.mergeAll(AssayRepositoryLive, CheckRunRepositoryLive, QuestionRepositoryLive, ObservationRepositoryLive,
    ProviderAttemptEvidenceRepositoryLive).pipe(Layer.provide(PgLive))
  const Providers = ProviderRegistryLive.pipe(Layer.provide(makeMockProviderLive(script)),
    Layer.provide(Layer.succeed(NineRouterProvider, { observe: () => Effect.fail(new ProviderUnsupported({})) })))
  const Runner = makeCheckRunnerLive(Schedule.recurs(0), { leaseSeconds: 60 }).pipe(Layer.provide(Repos), Layer.provide(Providers))
  const runtime = ManagedRuntime.make(Layer.mergeAll(Repos, Runner))
  const checkOnce = (businessId: string) => runtime.runPromise(Effect.flatMap(CheckRunner, r => r.runOnce({ businessId })))
  const runs = <A, E>(fn: (r: CheckRunRepository["Type"]) => Effect.Effect<A, E>) => runtime.runPromise(Effect.flatMap(CheckRunRepository, fn))
  const groups = (businessId: string) => runtime.runPromise(Effect.flatMap(AssayRepository, r => r.groups(businessId))) as Promise<readonly AssayGroupRow[]>
  const enqueueGroup = (businessId: string, questionId: string, n: number) => runtime.runPromise(Effect.flatMap(AssayRepository, r =>
    r.enqueueGroup({ businessId, questionId, provider: "mock", requestedModel: null, retrievalMode: "WEB_SEARCH", n })))

  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await runtime.dispose(); await pool.end() })

  const fixture = async () => {
    const account = (await pool.query("INSERT INTO accounts (name) VALUES ('TEST lease') RETURNING id")).rows[0].id as string
    const business = (await pool.query("INSERT INTO businesses (account_id, name) VALUES ($1,'TEST Northstar') RETURNING id", [account])).rows[0].id as string
    const question = (await pool.query("INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'How much does Northstar cost?') RETURNING id", [business])).rows[0].id as string
    return { business, question }
  }
  /** A worker claims one check and dies: the row is RUNNING with no progress. */
  const claimAndDie = async (business: string) => {
    const claimed = await runs(r => r.claimOne({ businessId: business }))
    expect(claimed?.status).toBe("RUNNING")
    return claimed!.id
  }
  const age = (runId: string, seconds: number) =>
    pool.query("UPDATE check_runs SET heartbeat_at = now() - make_interval(secs => $2), started_at = now() - make_interval(secs => $2) WHERE id = $1", [runId, seconds])
  const row = async (runId: string) => (await pool.query(
    "SELECT status, failure_class, failure_detail_safe, attempt_count, completed_at FROM check_runs WHERE id=$1", [runId])).rows[0]
  const count = async (q: string, id: string) => (await pool.query(q, [id])).rows[0].n as number

  it("a worker crash after claim is finished as WORKER_LOST once the lease expires, without a provider call", async () => {
    const f = await fixture()
    await pool.query("INSERT INTO check_runs (business_id, question_id, provider) VALUES ($1,$2,'mock')", [f.business, f.question])
    const lost = await claimAndDie(f.business)
    expect(await row(lost)).toMatchObject({ status: "RUNNING", attempt_count: 0 })
    await age(lost, 120)
    expect(await checkOnce(f.business)).toBe(true)
    expect(await row(lost)).toMatchObject({ status: "FAILED", failure_class: "WORKER_LOST", attempt_count: 0 })
    expect((await row(lost)).completed_at).not.toBeNull()
    expect((await row(lost)).failure_detail_safe).toContain("not retried automatically")
    expect(providerCalls).not.toContain(lost)
    expect(await count("SELECT count(*)::int n FROM observations WHERE check_run_id=$1", lost)).toBe(0)
    expect(await count("SELECT count(*)::int n FROM provider_attempt_evidence WHERE check_run_id=$1", lost)).toBe(0)
    // Recovery does not re-queue: nothing else exists for this business.
    expect(await count("SELECT count(*)::int n FROM check_runs WHERE business_id=$1", f.business)).toBe(1)
    expect(await checkOnce(f.business)).toBe(false)
  })

  it("a RUNNING check inside its lease is left alone", async () => {
    const f = await fixture()
    await pool.query("INSERT INTO check_runs (business_id, question_id, provider) VALUES ($1,$2,'mock')", [f.business, f.question])
    const running = await claimAndDie(f.business)
    await age(running, 30)
    expect(await checkOnce(f.business)).toBe(false)
    expect(await row(running)).toMatchObject({ status: "RUNNING", failure_class: null })
  })

  it("legacy RUNNING rows without a heartbeat expire from their start time", async () => {
    const f = await fixture()
    await pool.query("INSERT INTO check_runs (business_id, question_id, provider) VALUES ($1,$2,'mock')", [f.business, f.question])
    const legacy = await claimAndDie(f.business)
    await pool.query("UPDATE check_runs SET heartbeat_at = NULL, started_at = now() - interval '2 hours' WHERE id=$1", [legacy])
    await checkOnce(f.business)
    expect(await row(legacy)).toMatchObject({ status: "FAILED", failure_class: "WORKER_LOST" })
  })

  it("a recovered run fences its old owner: no further attempt or completion is accepted", async () => {
    const f = await fixture()
    await pool.query("INSERT INTO check_runs (business_id, question_id, provider) VALUES ($1,$2,'mock')", [f.business, f.question])
    const lost = await claimAndDie(f.business)
    await age(lost, 120)
    await checkOnce(f.business)
    // The zombie worker wakes up and tries to continue.
    await expect(runs(r => r.recordAttempt(lost))).rejects.toThrow(/lease lost/)
    await runs(r => r.markFinished(lost, "SUCCEEDED", null, null))
    expect(await row(lost)).toMatchObject({ status: "FAILED", failure_class: "WORKER_LOST", attempt_count: 0 })
  })

  it("an abandoned assay sample lets its group terminate as PARTIALLY_SUCCEEDED with the loss recorded", async () => {
    const f = await fixture()
    const group = await enqueueGroup(f.business, f.question, 3)
    const lost = await claimAndDie(f.business)
    const lostSample = (await pool.query("SELECT sample_number FROM check_runs WHERE id=$1", [lost])).rows[0].sample_number as number
    // The other two samples run normally.
    for (let i = 0; i < 5; i++) if (!await checkOnce(f.business)) break
    expect((await groups(f.business))[0]).toMatchObject({ id: group.id, status: "QUEUED" })
    await age(lost, 120)
    await checkOnce(f.business)
    expect((await groups(f.business))[0]).toMatchObject({
      id: group.id, status: "PARTIALLY_SUCCEEDED", missing_samples: [{ sampleNumber: lostSample, failureClass: "WORKER_LOST" }],
    })
    expect(providerCalls.filter(id => id === lost)).toHaveLength(0)
    // Exactly the n samples exist; recovery added no sample rows.
    expect(await count("SELECT count(*)::int n FROM check_runs WHERE assay_sample_group_id=$1", group.id)).toBe(3)
  })

  it("an assay group whose only sample was abandoned terminates FAILED", async () => {
    const f = await fixture()
    const group = await enqueueGroup(f.business, f.question, 1)
    const lost = await claimAndDie(f.business)
    await age(lost, 120)
    await checkOnce(f.business)
    expect((await groups(f.business))[0]).toMatchObject({ id: group.id, status: "FAILED", missing_samples: [{ sampleNumber: 1, failureClass: "WORKER_LOST" }] })
  })

  it("an explicit rerun after recovery observes normally", async () => {
    const f = await fixture()
    await pool.query("INSERT INTO check_runs (business_id, question_id, provider) VALUES ($1,$2,'mock')", [f.business, f.question])
    const lost = await claimAndDie(f.business)
    await age(lost, 120)
    await checkOnce(f.business)
    const rerun = await runs(r => r.enqueue({ businessId: f.business, questionId: f.question, provider: "mock", requestedModel: null }))
    expect(await checkOnce(f.business)).toBe(true)
    expect(await row(rerun.id)).toMatchObject({ status: "SUCCEEDED", attempt_count: 1 })
    expect(providerCalls.filter(id => id === rerun.id)).toHaveLength(1)
    expect(await count("SELECT count(*)::int n FROM observations WHERE check_run_id=$1", rerun.id)).toBe(1)
    expect(await row(lost)).toMatchObject({ status: "FAILED", failure_class: "WORKER_LOST" })
  })
})
