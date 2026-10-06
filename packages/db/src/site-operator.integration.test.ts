// SEARCH_OPERATOR_V1 persistence: run lifecycle, finding idempotency,
// evidence binding, approval/mutation/verification records, tenancy.
// Requires TEST_DATABASE_URL (CI provides postgres; skipped otherwise).
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import {
  SiteFindingEventRepository,
  SiteFindingEventRepositoryLive,
  SiteFindingRepository,
  SiteFindingRepositoryLive,
  SiteFixProposalRepository,
  SiteFixProposalRepositoryLive,
  SiteGscRepository,
  SiteGscRepositoryLive,
  SiteMutationRepository,
  SiteMutationRepositoryLive,
  SiteOperatorEventRepository,
  SiteOperatorEventRepositoryLive,
  SitePageObservationRepository,
  SitePageObservationRepositoryLive,
  SiteRunRepository,
  SiteRunRepositoryLive,
  SiteTargetRepository,
  SiteTargetRepositoryLive,
  SiteVerificationRepository,
  SiteVerificationRepositoryLive,
} from "./site-operator.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

suite("site operator persistence", () => {
  let pool: pg.Pool
  const PgLive = PgClient.layer({ url: Redacted.make(url) })
  const Repos = Layer.mergeAll(
    SiteTargetRepositoryLive,
    SiteRunRepositoryLive,
    SitePageObservationRepositoryLive,
    SiteFindingRepositoryLive,
    SiteFindingEventRepositoryLive,
    SiteFixProposalRepositoryLive,
    SiteMutationRepositoryLive,
    SiteVerificationRepositoryLive,
    SiteOperatorEventRepositoryLive,
    SiteGscRepositoryLive,
  ).pipe(Layer.provide(PgLive))

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    await pool.query("SELECT 1")
    // Other suites (or earlier failed attempts) may leave QUEUED site runs;
    // drain via legal transitions so claimAny is deterministic.
    await Effect.runPromise(Effect.gen(function*() {
      const runs = yield* SiteRunRepository
      for (;;) {
        const claimed = yield* runs.claimAny()
        if (!claimed) break
        yield* runs.markFinished(claimed.businessId, claimed.id, "FAILED", "TEST_DRAIN", "test fixture drain")
      }
    }).pipe(Effect.provide(Repos)))
  })
  afterAll(async () => {
    await pool.end()
  })

  const setup = async () => {
    const account = (await pool.query("INSERT INTO accounts (name) VALUES ($1) RETURNING id", [unique("acct")])).rows[0].id as string
    const business = (await pool.query("INSERT INTO businesses (account_id, name) VALUES ($1,'SiteBiz') RETURNING id", [account])).rows[0].id as string
    return { account, business }
  }

  const run = <A>(effect: Effect.Effect<A, unknown, SiteTargetRepository | SiteRunRepository | SitePageObservationRepository | SiteFindingRepository | SiteFindingEventRepository | SiteFixProposalRepository | SiteMutationRepository | SiteVerificationRepository | SiteOperatorEventRepository | SiteGscRepository>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Repos)) as Effect.Effect<A, Error>)

  const drainSiteRuns = () =>
    run(Effect.gen(function*() {
      const runs = yield* SiteRunRepository
      for (;;) {
        const claimed = yield* runs.claimAny()
        if (!claimed) break
        yield* runs.markFinished(claimed.businessId, claimed.id, "FAILED", "TEST_DRAIN", "test fixture drain")
      }
    }))

  it("enforces one active run per target with a typed conflict", async () => {
    await drainSiteRuns()
    const { business } = await setup()
    const site = await run(Effect.gen(function*() {
      return yield* (yield* SiteTargetRepository).create({ businessId: business, rootUrl: "https://example.com/", canonicalOrigin: "https://example.com", pathPrefix: "/" })
    }))
    const first = await run(Effect.gen(function*() {
      return yield* (yield* SiteRunRepository).enqueue({ businessId: business, siteTargetId: site.id })
    }))
    expect(first.state).toBe("QUEUED")
    const second = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* SiteRunRepository).enqueue({ businessId: business, siteTargetId: site.id })
      }).pipe(Effect.provide(Repos), Effect.either),
    )
    expect(second._tag).toBe("Left")
    // Terminal transition closes the run; a new run may then queue.
    await run(Effect.gen(function*() {
      const runs = yield* SiteRunRepository
      const claimed = yield* runs.claimAny()
      expect(claimed?.id).toBe(first.id)
      yield* runs.markFinished(business, first.id, "SUCCEEDED", null, null)
    }))
    const third = await run(Effect.gen(function*() {
      return yield* (yield* SiteRunRepository).enqueue({ businessId: business, siteTargetId: site.id })
    }))
    expect(third.state).toBe("QUEUED")
  })

  it("finding inserts are idempotent by identity key with evidence binding", async () => {
    await drainSiteRuns()
    const { business } = await setup()
    const ids = await run(Effect.gen(function*() {
      const sites = yield* SiteTargetRepository
      const runs = yield* SiteRunRepository
      const site = yield* sites.create({ businessId: business, rootUrl: "https://example.com/", canonicalOrigin: "https://example.com", pathPrefix: "/" })
      const enq = yield* runs.enqueue({ businessId: business, siteTargetId: site.id })
      const claimed = yield* runs.claimAny()
      return { site: site.id, run: claimed?.id ?? enq.id }
    }))
    const evidence = { robotsMeta: "noindex" }
    const first = await run(Effect.gen(function*() {
      return yield* (yield* SiteFindingRepository).upsertByIdentity({
        businessId: business,
        siteTargetId: ids.site,
        runId: ids.run,
        url: "https://example.com/services",
        canonicalUrl: "https://example.com/services",
        findingKind: "BLOCKED_BY_META",
        severity: "HIGH",
        category: "CRAWL_INDEX_RISK",
        evidence,
        diagnosis: "Search engines are explicitly instructed not to index this page.",
        recommendedAction: "Remove `noindex` from the production document head.",
        confidence: "HIGH",
        sourceDigest: "abc",
        evidenceDigest: "def",
        identityKey: "test-key-1",
      })
    }))
    expect(first.created).toBe(true)
    expect(first.row.status).toBe("OPEN")
    // Repeated identical inspection resolves the same row (no duplicate).
    const second = await run(Effect.gen(function*() {
      return yield* (yield* SiteFindingRepository).upsertByIdentity({
        businessId: business,
        siteTargetId: ids.site,
        runId: ids.run,
        url: "https://example.com/services",
        canonicalUrl: "https://example.com/services",
        findingKind: "BLOCKED_BY_META",
        severity: "HIGH",
        category: "CRAWL_INDEX_RISK",
        evidence,
        diagnosis: "Search engines are explicitly instructed not to index this page.",
        recommendedAction: "Remove `noindex` from the production document head.",
        confidence: "HIGH",
        sourceDigest: "abc",
        evidenceDigest: "def",
        identityKey: "test-key-1",
      })
    }))
    expect(second.created).toBe(false)
    expect(second.row.id).toBe(first.row.id)
    // Status moves append history; verification cannot be skipped.
    await run(Effect.gen(function*() {
      const findings = yield* SiteFindingRepository
      yield* findings.setStatus(business, first.row.id, "AWAITING_APPROVAL", "tester", null, null)
      const current = yield* findings.getScoped(business, first.row.id)
      expect(current?.status).toBe("AWAITING_APPROVAL")
    }))
    const history = await run(Effect.gen(function*() {
      return yield* (yield* SiteFindingEventRepository).listByFinding(business, first.row.id)
    }))
    expect(history.map((h) => h.toStatus)).toEqual(["OPEN", "AWAITING_APPROVAL"])
  })

  it("records proposals, mutations, and verifications with provenance", async () => {
    await drainSiteRuns()
    const { business } = await setup()
    const ctx = await run(Effect.gen(function*() {
      const sites = yield* SiteTargetRepository
      const runs = yield* SiteRunRepository
      const findings = yield* SiteFindingRepository
      const site = yield* sites.create({ businessId: business, rootUrl: "https://example.com/", canonicalOrigin: "https://example.com", pathPrefix: "/" })
      const enq = yield* runs.enqueue({ businessId: business, siteTargetId: site.id })
      const f = yield* findings.upsertByIdentity({
        businessId: business,
        siteTargetId: site.id,
        runId: enq.id,
        url: "https://example.com/x",
        canonicalUrl: "https://example.com/x",
        findingKind: "BLOCKED_BY_META",
        severity: "HIGH",
        category: "CRAWL_INDEX_RISK",
        evidence: {},
        diagnosis: "d",
        recommendedAction: "r",
        confidence: "HIGH",
        identityKey: "test-key-2",
      })
      const proposals = yield* SiteFixProposalRepository
      const proposal = yield* proposals.create({
        businessId: business,
        findingId: f.row.id,
        fixKind: "REMOVE_NOINDEX_META",
        target: "https://example.com/x",
        beforeText: '<meta name="robots" content="noindex">',
        afterText: "(robots meta tag removed)",
        rationale: "r",
        risk: "low",
        classification: "APPROVAL_REQUIRED",
        requiresApproval: true,
      })
      const approved = yield* proposals.setStatus(business, proposal.id, "APPROVED", "tester")
      const mutations = yield* SiteMutationRepository
      const mutation = yield* mutations.create({
        businessId: business,
        fixProposalId: proposal.id,
        findingId: f.row.id,
        adapterKind: "LOCAL_FILE",
        state: "CREATED",
        detail: "wrote index.html",
      })
      const marked = yield* mutations.markState(business, mutation.id, "BRANCH_CREATED", null, { branch: "ghostping/fix-1", commitSha: "abc123" })
      const verifications = yield* SiteVerificationRepository
      const verification = yield* verifications.create({ businessId: business, findingId: f.row.id, mutationId: mutation.id, result: "VERIFIED_FIXED", detail: "Ghostping verified the fix on the live site." })
      const events = yield* SiteOperatorEventRepository
      yield* events.append({ businessId: business, findingId: f.row.id, kind: "FIX_PROPOSED", payload: { fixKind: "REMOVE_NOINDEX_META" } })
      return { proposal: approved, mutation: marked, verification }
    }))
    expect(ctx.proposal?.status).toBe("APPROVED")
    expect(ctx.mutation?.state).toBe("BRANCH_CREATED")
    expect(ctx.mutation?.branch).toBe("ghostping/fix-1")
    expect(ctx.verification.result).toBe("VERIFIED_FIXED")
    // GSC boundary records blocked status honestly (never fake live data).
    await run(Effect.gen(function*() {
      const gsc = yield* SiteGscRepository
      yield* gsc.upsert(business, "sc-domain:example.com", "BLOCKED_MISSING_CREDENTIALS", "no OAuth credentials")
      const rows = yield* gsc.listByBusiness(business)
      expect(rows.some((r) => r.propertyUri === "sc-domain:example.com" && r.status === "BLOCKED_MISSING_CREDENTIALS")).toBe(true)
    }))
  })

  it("rejects cross-business writes and append-only rewrites", async () => {
    const a = await setup()
    const b = await setup()
    const siteA = (await pool.query("INSERT INTO site_targets (business_id, root_url, canonical_origin) VALUES ($1,'https://a.example/','https://a.example') RETURNING id", [a.business])).rows[0].id as string
    await expect(pool.query("INSERT INTO site_inspection_runs (business_id, site_target_id) VALUES ($1,$2)", [b.business, siteA])).rejects.toThrow()
    const runId = (await pool.query("INSERT INTO site_inspection_runs (business_id, site_target_id) VALUES ($1,$2) RETURNING id", [a.business, siteA])).rows[0].id as string
    const obsId = (await pool.query(
      "INSERT INTO site_page_observations (business_id, run_id, site_target_id, url, canonical_url, final_url, started_at, completed_at, indexability) VALUES ($1,$2,$3,'https://a.example/','https://a.example/','https://a.example/',now(),now(),'INDEXABLE') RETURNING id",
      [a.business, runId, siteA],
    )).rows[0].id as string
    await expect(pool.query("UPDATE site_page_observations SET indexability='UNKNOWN' WHERE id=$1", [obsId])).rejects.toThrow()
    await expect(pool.query("DELETE FROM site_page_observations WHERE id=$1", [obsId])).rejects.toThrow()
  })
})
