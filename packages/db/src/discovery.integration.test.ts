// PostgreSQL integration tests for Discovery V1 persistence: migration
// shape (tables, partial active-run index, tenancy + append-only
// triggers), tenant isolation, duplicate-active-run conflicts, atomic
// claims, frontier dedupe, and append-only evidence.
// Requires DATABASE_URL (CI provides a postgres service; skipped otherwise).
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import pg from "pg"
import { PgClient } from "@effect/sql-pg"
import { migrate } from "./migrate.js"
import {
  DiscoveryActiveRunConflict,
  DiscoveryFrontierRepository,
  DiscoveryFrontierRepositoryLive,
  DiscoveryMatchRepository,
  DiscoveryMatchRepositoryLive,
  DiscoveryObservationRepository,
  DiscoveryObservationRepositoryLive,
  DiscoveryRunRepository,
  DiscoveryRunRepositoryLive,
  DiscoveryScopeRepository,
  DiscoveryScopeRepositoryLive,
} from "./discovery.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const run = url ? describe : describe.skip
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

type Repos =
  | DiscoveryScopeRepository
  | DiscoveryRunRepository
  | DiscoveryFrontierRepository
  | DiscoveryObservationRepository
  | DiscoveryMatchRepository

run("postgres discovery v1", () => {
  let pool: pg.Pool
  let scope: Scope.CloseableScope
  let ctx: Context.Context<Repos>
  const runFx = <A, E>(fx: Effect.Effect<A, E, Repos>) => Effect.runPromise(Effect.provide(fx, ctx))
  const repo = <I, S>(tag: Context.Tag<I, S>) => Context.get(ctx as Context.Context<I>, tag)

  beforeAll(async () => {
    await migrate(url)
    pool = new pg.Pool({ connectionString: url })
    scope = await Effect.runPromise(Scope.make())
    const live = Layer.provide(
      Layer.mergeAll(
        DiscoveryScopeRepositoryLive,
        DiscoveryRunRepositoryLive,
        DiscoveryFrontierRepositoryLive,
        DiscoveryObservationRepositoryLive,
        DiscoveryMatchRepositoryLive,
      ),
      PgClient.layer({ url: Redacted.make(url) }),
    )
    ctx = await Effect.runPromise(Layer.buildWithScope(live, scope))
  })
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await pool.end()
  })

  /** A repository environment bound to a FRESH pool: one independent worker. */
  const withRunRepo = async () => {
    const inner = await Effect.runPromise(Scope.make())
    const live = Layer.provide(DiscoveryRunRepositoryLive, PgClient.layer({ url: Redacted.make(url) }))
    const innerCtx = await Effect.runPromise(Layer.buildWithScope(live, inner))
    return {
      scope: inner,
      value: Context.get(innerCtx, DiscoveryRunRepository),
      close: () => Effect.runPromise(Scope.close(inner, Exit.succeed(undefined))),
    }
  }

  const setupBusiness = async () => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Acme') RETURNING id`, [accountId])).rows[0]["id"] as string
    return { accountId, businessId }
  }

  const setupScope = (businessId: string) => {
    const host = `scope-${Date.now()}-${Math.floor(Math.random() * 1e9)}.example`
    return runFx(
      Effect.flatMap(DiscoveryScopeRepository, (r) =>
        r.create({ businessId, rootUrl: `https://${host}/`, canonicalOrigin: `https://${host}`, pathPrefix: "/" }),
      ),
    )
  }

  const setupRun = (businessId: string, scopeId: string) =>
    runFx(
      Effect.flatMap(DiscoveryRunRepository, (r) =>
        r.enqueue({ businessId, scopeId, matcherVersion: "matcher/1", policyVersion: "policy/1" }),
      ),
    )

  const setupFact = async (businessId: string, value = "49 USD") =>
    (await pool.query(
      `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, source_kind) VALUES ($1,'Acme Starter','monthly price',$2,'CURRENCY','2026-01-01T00:00:00Z','MANUAL') RETURNING id`,
      [businessId, value],
    )).rows[0]["id"] as string

  const setupObservation = (businessId: string, scopeId: string, runId: string, canonicalUrl: string) =>
    runFx(
      Effect.flatMap(DiscoveryObservationRepository, (r) =>
        r.insert({
          businessId, scopeId, runId, resourceKind: "PAGE",
          requestedUrl: canonicalUrl, canonicalUrl, finalUrl: canonicalUrl, discoveredVia: "ROOT",
          startedAt: "2026-10-03T10:00:00.000Z", completedAt: "2026-10-03T10:00:01.000Z",
          httpStatus: 200, contentType: "text/html", bodyDigest: "aa", bodyBytes: 128,
          collectionState: "FETCHED",
        }),
      ),
    )

  const setupMatch = (businessId: string, runId: string, pageObservationId: string, factId: string) =>
    runFx(
      Effect.flatMap(DiscoveryMatchRepository, (r) =>
        r.insertMany({
          businessId, runId,
          matches: [{
            pageObservationId, lineageRootFactId: factId, matchedFactId: factId, matchedFactVersion: 1,
            matchedValue: "49 USD", matchSurface: "VISIBLE_TEXT",
            evidenceLocator: "body.main", evidenceSnippet: "Starter is 49 USD per month",
            relationAtScan: "CURRENT_VALUE", matcherVersion: "matcher/1",
          }],
        }),
      ),
    )

  it("migrations create discovery tables with the active-run index and triggers", async () => {
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('discovery_scopes','discovery_runs','discovery_frontier','discovery_observations','discovery_matches')`,
    )
    expect(tables.rows).toHaveLength(5)
    const partial = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'uq_discovery_runs_one_active_per_scope'`,
    )
    expect(partial.rows).toHaveLength(1)
    expect(String(partial.rows[0]?.["indexdef"])).toMatch(/WHERE/)
    const triggers = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_discovery_scopes_tenancy','trg_discovery_runs_tenancy','trg_discovery_frontier_tenancy','trg_discovery_observations_tenancy','trg_discovery_matches_tenancy','trg_discovery_observations_no_update','trg_discovery_matches_no_update')`,
    )
    expect(triggers.rows).toHaveLength(7)
  })

  it("tenancy: cross-business discovery rows stay invisible, cross-business writes fail", async () => {
    const a = await setupBusiness()
    const b = await setupBusiness()
    const s = await setupScope(a.businessId)
    const r = await setupRun(a.businessId, s.id)
    await runFx(
      Effect.flatMap(DiscoveryFrontierRepository, (f) =>
        f.enqueueMany({
          businessId: a.businessId, runId: r.id,
          entries: [{ canonicalUrl: "https://x.example/", requestedUrl: "https://x.example/", discoveredVia: "ROOT", orderKey: "0001" }],
        }),
      ),
    )
    const factId = await setupFact(a.businessId)
    const obs = await setupObservation(a.businessId, s.id, r.id, "https://x.example/")
    await setupMatch(a.businessId, r.id, obs.id, factId)

    // Cross-business reads behave as 404: null or empty, never leaking.
    expect(await runFx(Effect.flatMap(DiscoveryScopeRepository, (x) => x.getScoped(b.businessId, s.id)))).toBeNull()
    expect(await runFx(Effect.flatMap(DiscoveryScopeRepository, (x) => x.listByBusiness(b.businessId)))).toEqual([])
    expect(await runFx(Effect.flatMap(DiscoveryRunRepository, (x) => x.getScoped(b.businessId, r.id)))).toBeNull()
    expect(await runFx(Effect.flatMap(DiscoveryRunRepository, (x) => x.listByScope(b.businessId, s.id)))).toEqual([])
    expect(await runFx(Effect.flatMap(DiscoveryFrontierRepository, (x) => x.counts(b.businessId, r.id)))).toEqual({
      pending: 0, inProgress: 0, done: 0, skipped: 0,
    })
    expect(await runFx(Effect.flatMap(DiscoveryObservationRepository, (x) => x.listByRun(b.businessId, r.id)))).toEqual([])
    expect(await runFx(Effect.flatMap(DiscoveryMatchRepository, (x) => x.listByRun(b.businessId, r.id)))).toEqual([])
    // Own-business reads see the rows.
    expect((await runFx(Effect.flatMap(DiscoveryObservationRepository, (x) => x.listByRun(a.businessId, r.id)))).map((o) => o.id)).toEqual([obs.id])
    expect((await runFx(Effect.flatMap(DiscoveryMatchRepository, (x) => x.listByRun(a.businessId, r.id)))).map((m) => m.pageObservationId)).toEqual([obs.id])

    // Cross-business writes fail at the database layer.
    await expect(pool.query(
      `INSERT INTO discovery_runs (business_id, scope_id) VALUES ($1,$2)`,
      [b.businessId, s.id],
    )).rejects.toThrow(/crosses business boundary/)
    await expect(pool.query(
      `INSERT INTO discovery_frontier (business_id, run_id, canonical_url, requested_url, discovered_via, order_key) VALUES ($1,$2,'https://x.example/a','https://x.example/a','LINK','0002')`,
      [b.businessId, r.id],
    )).rejects.toThrow(/crosses business boundary/)
    await expect(pool.query(
      `INSERT INTO discovery_observations (business_id, scope_id, run_id, resource_kind, requested_url, canonical_url, final_url, discovered_via, started_at, completed_at, collection_state) VALUES ($1,$2,$3,'PAGE','https://x.example/','https://x.example/','https://x.example/','ROOT',now(),now(),'FETCHED')`,
      [b.businessId, s.id, r.id],
    )).rejects.toThrow(/crosses business boundary/)
    const foreignFact = await setupFact(b.businessId)
    await expect(pool.query(
      `INSERT INTO discovery_matches (business_id, run_id, page_observation_id, lineage_root_fact_id, matched_fact_id, matched_fact_version, matched_value, match_surface, evidence_locator, evidence_snippet, relation_at_scan, matcher_version) VALUES ($1,$2,$3,$4,$5,1,'49 USD','VISIBLE_TEXT','body','snippet','CURRENT_VALUE','matcher/1')`,
      [a.businessId, r.id, obs.id, foreignFact, foreignFact],
    )).rejects.toThrow(/another business/)
  })

  it("duplicate active runs conflict; a finished scope accepts a new run", async () => {
    const { businessId } = await setupBusiness()
    const s = await setupScope(businessId)
    const runs = repo(DiscoveryRunRepository)
    const r1 = await runFx(runs.enqueue({ businessId, scopeId: s.id }))

    const dup = await Effect.runPromiseExit(runs.enqueue({ businessId, scopeId: s.id }))
    expect(Exit.isFailure(dup)).toBe(true)
    if (dup._tag === "Failure" && dup.cause._tag === "Fail") {
      expect(dup.cause.error).toBeInstanceOf(DiscoveryActiveRunConflict)
      if (dup.cause.error instanceof DiscoveryActiveRunConflict) {
        expect(dup.cause.error.activeRunId).toBe(r1.id)
      }
    }

    // RUNNING still counts as active: claiming does not free the scope.
    const claimed = await runFx(runs.claimOne(businessId, s.id))
    expect(claimed?.id).toBe(r1.id)
    expect(claimed?.state).toBe("RUNNING")
    expect(Exit.isFailure(await Effect.runPromiseExit(runs.enqueue({ businessId, scopeId: s.id })))).toBe(true)

    // The partial unique index backstops direct SQL as well.
    await expect(pool.query(`INSERT INTO discovery_runs (business_id, scope_id) VALUES ($1,$2)`, [businessId, s.id])).rejects.toThrow(/duplicate key/)

    // Terminal rows never reopen: a second finish is a no-op, heartbeat ignored.
    const beatBefore = (await pool.query(`SELECT heartbeat_at FROM discovery_runs WHERE id = $1`, [r1.id])).rows[0]["heartbeat_at"] as Date
    expect(beatBefore).not.toBeNull()
    await runFx(runs.markFinished(businessId, r1.id, "SUCCEEDED", null, null))
    await runFx(runs.markFinished(businessId, r1.id, "FAILED", "UNKNOWN", "late"))
    await runFx(runs.heartbeat(businessId, r1.id))
    const row = (await pool.query(`SELECT state, failure_class, heartbeat_at FROM discovery_runs WHERE id = $1`, [r1.id])).rows[0] as Record<string, unknown>
    expect(row["state"]).toBe("SUCCEEDED")
    expect(row["failure_class"]).toBeNull()
    expect((row["heartbeat_at"] as Date).toISOString()).toBe(beatBefore.toISOString())

    // A finished scope accepts exactly one new run.
    const r2 = await runFx(runs.enqueue({ businessId, scopeId: s.id }))
    expect(r2.id).not.toBe(r1.id)
    expect(Exit.isFailure(await Effect.runPromiseExit(runs.enqueue({ businessId, scopeId: s.id })))).toBe(true)
  })

  it("1 queued run + 2 simultaneous claimers = exactly 1 successful claim", async () => {
    const { businessId } = await setupBusiness()
    const s = await setupScope(businessId)
    await setupRun(businessId, s.id)
    const e1 = await withRunRepo()
    const e2 = await withRunRepo()
    try {
      const [c1, c2] = await Promise.all([
        Effect.runPromise(e1.value.claimOne(businessId, s.id)),
        Effect.runPromise(e2.value.claimOne(businessId, s.id)),
      ])
      expect([c1, c2].filter((c) => c !== null)).toHaveLength(1)
    } finally {
      await e1.close()
      await e2.close()
    }
  })

  it("frontier dedupes by canonical URL and moves PENDING -> IN_PROGRESS -> DONE | SKIPPED", async () => {
    const { businessId } = await setupBusiness()
    const s = await setupScope(businessId)
    const r = await setupRun(businessId, s.id)
    const frontier = repo(DiscoveryFrontierRepository)
    const entries = [
      { canonicalUrl: "https://s.example/", requestedUrl: "https://s.example/", discoveredVia: "ROOT", orderKey: "0001" },
      { canonicalUrl: "https://s.example/pricing", requestedUrl: "https://s.example/pricing", discoveredVia: "SITEMAP", orderKey: "0002" },
      { canonicalUrl: "https://s.example/docs", requestedUrl: "https://s.example/docs", discoveredVia: "LINK", orderKey: "0003" },
    ] as const
    expect(await runFx(frontier.enqueueMany({ businessId, runId: r.id, entries: [...entries] }))).toBe(3)
    // Re-enqueueing identical identities inserts nothing.
    expect(await runFx(frontier.enqueueMany({ businessId, runId: r.id, entries: [...entries] }))).toBe(0)
    expect(await runFx(frontier.counts(businessId, r.id))).toEqual({ pending: 3, inProgress: 0, done: 0, skipped: 0 })

    const first = await runFx(frontier.claimNext(businessId, r.id))
    expect(first?.canonicalUrl).toBe("https://s.example/")
    expect(first?.state).toBe("IN_PROGRESS")
    expect(first?.leaseAt).not.toBeNull()
    expect(first?.attempts).toBe(1)
    const second = await runFx(frontier.claimNext(businessId, r.id))
    expect(second?.canonicalUrl).toBe("https://s.example/pricing")

    await runFx(frontier.markDone(businessId, first!.id))
    await runFx(frontier.markSkipped(businessId, second!.id, "ROBOTS_DENIED"))
    expect(await runFx(frontier.counts(businessId, r.id))).toEqual({ pending: 1, inProgress: 0, done: 1, skipped: 1 })
    // Terminal entries never reopen.
    await runFx(frontier.markDone(businessId, second!.id))
    expect((await runFx(frontier.counts(businessId, r.id))).skipped).toBe(1)
  })

  it("observations and matches are append-only: UPDATE and DELETE are rejected", async () => {
    const { businessId } = await setupBusiness()
    const s = await setupScope(businessId)
    const r = await setupRun(businessId, s.id)
    const factId = await setupFact(businessId)
    const obs = await setupObservation(businessId, s.id, r.id, "https://a.example/")
    const [match] = await setupMatch(businessId, r.id, obs.id, factId)
    expect(match).toBeDefined()

    await expect(pool.query(`UPDATE discovery_observations SET failure = 'TIMEOUT' WHERE id = $1`, [obs.id])).rejects.toThrow(/append-only/)
    await expect(pool.query(`DELETE FROM discovery_observations WHERE id = $1`, [obs.id])).rejects.toThrow(/append-only/)
    await expect(pool.query(`UPDATE discovery_matches SET evidence_snippet = 'x' WHERE id = $1`, [match!.id])).rejects.toThrow(/append-only/)
    await expect(pool.query(`DELETE FROM discovery_matches WHERE id = $1`, [match!.id])).rejects.toThrow(/append-only/)

    // Evidence survived the rejected mutations.
    expect((await pool.query(`SELECT failure FROM discovery_observations WHERE id = $1`, [obs.id])).rows[0]["failure"]).toBeNull()
    expect((await pool.query(`SELECT evidence_snippet FROM discovery_matches WHERE id = $1`, [match!.id])).rows[0]["evidence_snippet"]).not.toBe("x")
  })
})
