// PostgreSQL 16 integration tests for explicit intervention→source-binding
// linkage: append-only links with database-enforced tenancy (intervention,
// binding, and link row share one business; before-observations must be
// successful collections of the binding's own target), plus the guarantee
// that historical interventions without rows read as unlinked (UNKNOWN
// downstream, never backfilled). Requires DATABASE_URL (skipped otherwise,
// like the other DB suites).
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import pg from "pg"
import { PgClient } from "@effect/sql-pg"
import {
  InterventionBindingRepository,
  InterventionBindingRepositoryLive,
  InterventionRepository,
  InterventionRepositoryLive,
  type InterventionInput,
} from "./evidence.js"
import { migrate } from "./migrate.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const run = url ? describe : describe.skip
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

type Repos = InterventionRepository | InterventionBindingRepository

run("postgres intervention source bindings v1", () => {
  let pool: pg.Pool
  let scope: Scope.CloseableScope
  let ctx: Context.Context<Repos>
  const runFx = <A, E>(fx: Effect.Effect<A, E, Repos>) => Effect.runPromise(Effect.provide(fx, ctx))
  const runExit = <A, E>(fx: Effect.Effect<A, E, Repos>) => Effect.runPromiseExit(Effect.provide(fx, ctx))

  beforeAll(async () => {
    await migrate(url)
    pool = new pg.Pool({ connectionString: url })
    scope = await Effect.runPromise(Scope.make())
    const live = Layer.provide(
      Layer.mergeAll(InterventionRepositoryLive, InterventionBindingRepositoryLive),
      PgClient.layer({ url: Redacted.make(url) }),
    )
    ctx = await Effect.runPromise(Layer.buildWithScope(live, scope))
  })
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await pool.end()
  })

  const setupBusiness = async () => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Acme') RETURNING id`, [accountId])).rows[0]["id"] as string
    const questionId = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'How much does Acme Starter cost?') RETURNING id`, [businessId])).rows[0]["id"] as string
    const factId = (await pool.query(
      `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from) VALUES ($1,'Acme Starter','monthly price','$39/month','CURRENCY','2026-01-01T00:00:00Z') RETURNING id`,
      [businessId],
    )).rows[0]["id"] as string
    const targetId = (await pool.query(`INSERT INTO source_targets (business_id, url, control) VALUES ($1,'https://acme.example/pricing','OWNED') RETURNING id`, [businessId])).rows[0]["id"] as string
    const bindingId = (await pool.query(
      `INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator) VALUES ($1,$2,$3,'JSON_LD','offers.price','MONEY') RETURNING id`,
      [businessId, factId, targetId],
    )).rows[0]["id"] as string
    return { accountId, businessId, questionId, factId, targetId, bindingId }
  }

  const sourceObs = async (
    biz: { businessId: string; targetId: string },
    completedAt: string,
    state: "FETCHED" | "NOT_MODIFIED" | "FAILED",
    failure: string | null = null,
  ) =>
    (await pool.query(
      `INSERT INTO source_observations (business_id, source_target_id, requested_url, final_url, started_at, completed_at, http_status, content_type, body_digest, body_bytes, collection_state, failure)
       VALUES ($1,$2,'https://acme.example/pricing','https://acme.example/pricing',$3,$3,200,'text/html','aa',128,$4,$5) RETURNING id`,
      [biz.businessId, biz.targetId, completedAt, state, failure],
    )).rows[0]["id"] as string

  const aiIssue = async (biz: { businessId: string; questionId: string }, answer: string, collectedAt: string, text: string) => {
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'SUCCEEDED') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
    const digest = sha(unique("raw"))
    const rawId = (await pool.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') RETURNING id`, [digest])).rows[0]["id"] as string
    const observationId = (await pool.query(
      `INSERT INTO observations (business_id, check_run_id, provider, collected_at, answer_text, raw_evidence_id, raw_digest) VALUES ($1,$2,'mock',$3,$4,$5,$6) RETURNING id`,
      [biz.businessId, runId, collectedAt, answer, rawId, digest],
    )).rows[0]["id"] as string
    const issueId = (await pool.query(`INSERT INTO candidate_claims (business_id, observation_id, text, origin) VALUES ($1,$2,$3,'MANUAL_EXACT_SPAN') RETURNING id`, [biz.businessId, observationId, text])).rows[0]["id"] as string
    return { observationId, issueId }
  }

  const intervention = (businessId: string, issueIds: Array<string>): InterventionInput => ({
    businessId, issueIds, type: "SOURCE_UPDATED", target: "https://acme.example/pricing", performedAt: "2026-10-01T12:00:00.000Z",
    actor: "HUMAN", actorId: null, notes: null, evidenceBeforeDigest: null, evidenceAfterDigest: null,
    supersedesId: null, correctionReason: null,
  })
  const appendIntervention = (businessId: string, issueId: string) =>
    runFx(Effect.flatMap(InterventionRepository, (r) => r.append(intervention(businessId, [issueId]))))
  const link = (input: { businessId: string; interventionId: string; sourceBindingId: string; beforeSourceObservationId: string | null }) =>
    runFx(Effect.flatMap(InterventionBindingRepository, (r) => r.linkInterventionBinding(input)))
  const listByIssue = (businessId: string, issueId: string) =>
    runFx(Effect.flatMap(InterventionBindingRepository, (r) => r.listByIssue(businessId, issueId)))

  it("migration 0015 re-runs cleanly and stores linkage only", async () => {
    await migrate(url)
    await migrate(url)
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'intervention_source_bindings'`)
    const names = cols.rows.map((r) => r["column_name"] as string)
    for (const expected of ["intervention_id", "business_id", "source_binding_id", "before_source_observation_id", "created_at"]) {
      expect(names).toContain(expected)
    }
    for (const banned of ["outcome", "match_classification", "observed_change", "causal_attribution", "status", "evidence_before_digest"]) {
      expect(names).not.toContain(banned)
    }
    const triggers = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_intervention_source_bindings_tenancy','trg_intervention_source_bindings_no_update','trg_intervention_source_bindings_no_truncate') AND NOT tgisinternal`,
    )
    expect(triggers.rows).toHaveLength(3)
  })

  it("links one intervention to its binding with before-evidence", async () => {
    const biz = await setupBusiness()
    const beforeId = await sourceObs(biz, "2026-10-01T10:00:00.000Z", "FETCHED")
    const { issueId } = await aiIssue(biz, "$29/month", "2026-10-01T00:00:00.000Z", "$29/month")
    const iv = await appendIntervention(biz.businessId, issueId)
    const row = await link({ businessId: biz.businessId, interventionId: iv.id, sourceBindingId: biz.bindingId, beforeSourceObservationId: beforeId })
    expect(row).toMatchObject({
      interventionId: iv.id,
      businessId: biz.businessId,
      sourceBindingId: biz.bindingId,
      beforeSourceObservationId: beforeId,
    })
    expect(await listByIssue(biz.businessId, issueId)).toEqual([row])
  })

  it("links with NULL before-evidence when nothing was collected yet", async () => {
    const biz = await setupBusiness()
    const { issueId } = await aiIssue(biz, "$29/month", "2026-10-01T00:00:00.000Z", "$29/month")
    const iv = await appendIntervention(biz.businessId, issueId)
    const row = await link({ businessId: biz.businessId, interventionId: iv.id, sourceBindingId: biz.bindingId, beforeSourceObservationId: null })
    expect(row.beforeSourceObservationId).toBeNull()
    expect(await listByIssue(biz.businessId, issueId)).toEqual([row])
  })

  it("rejects cross-business bindings", async () => {
    const a = await setupBusiness()
    const b = await setupBusiness()
    const { issueId } = await aiIssue(a, "$29/month", "2026-10-01T00:00:00.000Z", "$29/month")
    const iv = await appendIntervention(a.businessId, issueId)
    // Business B's binding linked under business A: repository path fails.
    expect(Exit.isFailure(await runExit(Effect.flatMap(InterventionBindingRepository, (r) =>
      r.linkInterventionBinding({ businessId: a.businessId, interventionId: iv.id, sourceBindingId: b.bindingId, beforeSourceObservationId: null }))))).toBe(true)
    // Same via raw SQL: the trigger names the boundary, and nothing lands.
    await expect(pool.query(
      `INSERT INTO intervention_source_bindings (intervention_id, business_id, source_binding_id) VALUES ($1,$2,$3)`,
      [iv.id, a.businessId, b.bindingId],
    )).rejects.toThrow(/different businesses/)
    // A link row carrying the wrong business id is rejected too.
    await expect(pool.query(
      `INSERT INTO intervention_source_bindings (intervention_id, business_id, source_binding_id) VALUES ($1,$2,$3)`,
      [iv.id, b.businessId, a.bindingId],
    )).rejects.toThrow(/different businesses/)
    expect(await listByIssue(a.businessId, issueId)).toEqual([])
  })

  it("rejects before-observations on another target", async () => {
    const biz = await setupBusiness()
    const otherTarget = (await pool.query(`INSERT INTO source_targets (business_id, url, control) VALUES ($1,'https://docs.acme.example/billing','OWNED') RETURNING id`, [biz.businessId])).rows[0]["id"] as string
    const foreign = await sourceObs({ businessId: biz.businessId, targetId: otherTarget }, "2026-10-01T10:00:00.000Z", "FETCHED")
    const { issueId } = await aiIssue(biz, "$29/month", "2026-10-01T00:00:00.000Z", "$29/month")
    const iv = await appendIntervention(biz.businessId, issueId)
    expect(Exit.isFailure(await runExit(Effect.flatMap(InterventionBindingRepository, (r) =>
      r.linkInterventionBinding({ businessId: biz.businessId, interventionId: iv.id, sourceBindingId: biz.bindingId, beforeSourceObservationId: foreign }))))).toBe(true)
    await expect(pool.query(
      `INSERT INTO intervention_source_bindings (intervention_id, business_id, source_binding_id, before_source_observation_id) VALUES ($1,$2,$3,$4)`,
      [iv.id, biz.businessId, biz.bindingId, foreign],
    )).rejects.toThrow(/not successful evidence/)
    expect(await listByIssue(biz.businessId, issueId)).toEqual([])
  })

  it("rejects failed-collection before-observations", async () => {
    const biz = await setupBusiness()
    const failed = await sourceObs(biz, "2026-10-01T10:00:00.000Z", "FAILED", "TIMEOUT")
    const { issueId } = await aiIssue(biz, "$29/month", "2026-10-01T00:00:00.000Z", "$29/month")
    const iv = await appendIntervention(biz.businessId, issueId)
    await expect(pool.query(
      `INSERT INTO intervention_source_bindings (intervention_id, business_id, source_binding_id, before_source_observation_id) VALUES ($1,$2,$3,$4)`,
      [iv.id, biz.businessId, biz.bindingId, failed],
    )).rejects.toThrow(/not successful evidence/)
    // A nominally successful state that still carries a failure is rejected too.
    const tainted = await sourceObs(biz, "2026-10-01T11:00:00.000Z", "FETCHED", "TIMEOUT")
    await expect(pool.query(
      `INSERT INTO intervention_source_bindings (intervention_id, business_id, source_binding_id, before_source_observation_id) VALUES ($1,$2,$3,$4)`,
      [iv.id, biz.businessId, biz.bindingId, tainted],
    )).rejects.toThrow(/not successful evidence/)
    expect(await listByIssue(biz.businessId, issueId)).toEqual([])
  })

  it("links are append-only", async () => {
    const biz = await setupBusiness()
    const beforeId = await sourceObs(biz, "2026-10-01T10:00:00.000Z", "NOT_MODIFIED")
    const { issueId } = await aiIssue(biz, "$29/month", "2026-10-01T00:00:00.000Z", "$29/month")
    const iv = await appendIntervention(biz.businessId, issueId)
    await link({ businessId: biz.businessId, interventionId: iv.id, sourceBindingId: biz.bindingId, beforeSourceObservationId: beforeId })
    await expect(pool.query(
      `UPDATE intervention_source_bindings SET before_source_observation_id = NULL WHERE intervention_id = $1`, [iv.id],
    )).rejects.toThrow(/append-only/)
    await expect(pool.query(`DELETE FROM intervention_source_bindings WHERE intervention_id = $1`, [iv.id])).rejects.toThrow(/append-only/)
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await expect(client.query(`TRUNCATE intervention_source_bindings`)).rejects.toThrow(/append-only/)
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
    expect(await listByIssue(biz.businessId, issueId)).toHaveLength(1)
  })

  it("historical interventions without rows read as unlinked, scoped by issue and business", async () => {
    const biz = await setupBusiness()
    const other = await setupBusiness()
    const first = await aiIssue(biz, "$29/month", "2026-10-01T00:00:00.000Z", "$29/month")
    const second = await aiIssue(biz, "$39/month", "2026-10-02T00:00:00.000Z", "$39/month")
    const iv = await appendIntervention(biz.businessId, first.issueId)
    // No link row: the historical action reads as unlinked (empty, never null-row backfill).
    expect(await listByIssue(biz.businessId, first.issueId)).toEqual([])
    await link({ businessId: biz.businessId, interventionId: iv.id, sourceBindingId: biz.bindingId, beforeSourceObservationId: null })
    // Linked on the first issue only; the second issue and other businesses see nothing.
    expect(await listByIssue(biz.businessId, first.issueId)).toHaveLength(1)
    expect(await listByIssue(biz.businessId, second.issueId)).toEqual([])
    expect(await listByIssue(other.businessId, first.issueId)).toEqual([])
  })
})
