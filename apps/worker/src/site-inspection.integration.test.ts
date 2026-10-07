// SEARCH_OPERATOR_V1 closed-loop acceptance (worker level, deterministic).
// A stub transport serves a fixture site; no real network, no randomness.
//
// Fixture: https://example.com/ (healthy) + /services/plumbing (noindex).
// Demo 1: inspect -> BLOCKED_BY_META -> approve -> mutate -> redeploy ->
//   verify -> VERIFIED_FIXED with Before/Change/After provenance.
// Demo 2: a mutation that never reaches production verifies as
//   VERIFIED_NOT_FIXED (the system never claims success on merge alone).
// Requires TEST_DATABASE_URL (CI provides postgres; skipped otherwise).
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import {
  SiteFindingRepository,
  SiteFindingRepositoryLive,
  SiteFindingEventRepositoryLive,
  SiteFixProposalRepositoryLive,
  SiteGscRepositoryLive,
  SiteMutationRepositoryLive,
  SiteOperatorEventRepositoryLive,
  SitePageObservationRepositoryLive,
  SiteRunRepository,
  SiteRunRepositoryLive,
  SiteTargetRepository,
  SiteTargetRepositoryLive,
  SiteVerificationRepositoryLive,
} from "@openrecord/db"
import type { HttpTransport } from "@openrecord/representation"
import { SiteInspectionRunner, makeSiteInspectionRunnerLive } from "./site-inspection-runner.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

const HOME_HTML = `<!doctype html><html><head><title>Acme Plumbing</title>
<meta name="description" content="Same-day plumbing.">
<link rel="canonical" href="https://example.com/">
</head><body><h1>Acme Plumbing</h1><a href="/services/plumbing">Plumbing</a></body></html>`

const PLUMBING_BROKEN = `<!doctype html><html><head><title>Plumbing Services</title>
<meta name="description" content="Plumbing services.">
<link rel="canonical" href="https://example.com/services/plumbing">
<meta name="robots" content="noindex">
</head><body><h1>Plumbing Services</h1></body></html>`

const PLUMBING_FIXED = `<!doctype html><html><head><title>Plumbing Services</title>
<meta name="description" content="Plumbing services.">
<link rel="canonical" href="https://example.com/services/plumbing">
</head><body><h1>Plumbing Services</h1></body></html>`

const ROBOTS = `User-agent: *
Disallow:

Sitemap: https://example.com/sitemap.xml
`

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/</loc></url>
<url><loc>https://example.com/services/plumbing</loc></url>
</urlset>`

const enc = new TextEncoder()

const serve = (bodies: Map<string, { status: number; contentType: string; body: string }>): HttpTransport => ({
  lookup: async (host) => (/^[0-9a-fA-F:.]+$/.test(host) ? [host] : ["93.184.216.34"]),
  fetch: async (raw) => {
    const path = new URL(raw).pathname
    const entry = bodies.get(path)
    if (!entry) {
      return { status: 404, headers: { "content-type": "text/html" }, body: enc.encode("<html><body>gone</body></html>"), peerIp: "93.184.216.34" }
    }
    return {
      status: entry.status,
      headers: { "content-type": entry.contentType },
      body: enc.encode(entry.body),
      peerIp: "93.184.216.34",
    }
  },
})

suite("site inspection closed loop", () => {
  let pool: pg.Pool
  const bodies = new Map<string, { status: number; contentType: string; body: string }>([
    ["/robots.txt", { status: 200, contentType: "text/plain", body: ROBOTS }],
    ["/sitemap.xml", { status: 200, contentType: "application/xml", body: SITEMAP }],
    ["/", { status: 200, contentType: "text/html", body: HOME_HTML }],
    ["/services/plumbing", { status: 200, contentType: "text/html", body: PLUMBING_BROKEN }],
  ])
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
  const Runner = makeSiteInspectionRunnerLive({ transport: serve(bodies) }).pipe(Layer.provide(Repos))

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    await pool.query("SELECT 1")
    await Effect.runPromise(Effect.gen(function*() {
      const runs = yield* SiteRunRepository
      for (;;) {
        const claimed = yield* runs.claimAny()
        if (!claimed) break
        yield* runs.markFinished(claimed.businessId, claimed.id, "FAILED", "TEST_DRAIN", "drain")
      }
    }).pipe(Effect.provide(Repos)))
  })
  afterAll(async () => {
    await pool.end()
  })

  const setupSite = async () => {
    const account = (await pool.query("INSERT INTO accounts (name) VALUES ('Site loop fixture') RETURNING id")).rows[0].id as string
    const business = (await pool.query("INSERT INTO businesses (account_id, name) VALUES ($1,'LoopBiz') RETURNING id", [account])).rows[0].id as string
    const ids = await Effect.runPromise(Effect.gen(function*() {
      const sites = yield* SiteTargetRepository
      const runs = yield* SiteRunRepository
      const site = yield* sites.create({ businessId: business, rootUrl: "https://example.com/", canonicalOrigin: "https://example.com", pathPrefix: "/" })
      const run = yield* runs.enqueue({ businessId: business, siteTargetId: site.id })
      return { site: site.id, run: run.id }
    }).pipe(Effect.provide(Repos)))
    return { business, ...ids }
  }

  const runOnce = () =>
    Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* SiteInspectionRunner).runOnce()
    }).pipe(Effect.provide(Runner)))

  // Race-tolerant: other suites may leave QUEUED site runs behind, and
  // claimAny takes the oldest first. Keep pumping until OUR run is terminal
  // (bounded); every iteration finishes exactly one run.
  const runUntilDone = async (runId: string, max = 12): Promise<string> => {
    for (let i = 0; i < max; i++) {
      await runOnce()
      const state = (await pool.query("SELECT state FROM site_inspection_runs WHERE id=$1", [runId])).rows[0].state as string
      if (["SUCCEEDED", "PARTIALLY_SUCCEEDED", "FAILED"].includes(state)) return state
    }
    throw new Error(`run ${runId} did not reach a terminal state`)
  }

  const advance = (business: string, findingId: string, to: string) =>
    Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* SiteFindingRepository).setStatus(business, findingId, to, "test", "test advance", null)
    }).pipe(Effect.provide(Repos)))

  it("discovers the noindex page with exact evidence and proposes an approval-gated fix", async () => {
    const f = await setupSite()
    expect(await runUntilDone(f.run)).toBe("SUCCEEDED")
    const run = (await pool.query("SELECT state, urls_inspected, urls_failed, findings_produced FROM site_inspection_runs WHERE id=$1", [f.run])).rows[0]
    expect(run.state).toBe("SUCCEEDED")
    expect(Number(run.urls_inspected)).toBe(2)
    expect(Number(run.urls_failed)).toBe(0)
    const findings = (await pool.query("SELECT id, finding_kind, severity, status, confidence, evidence FROM site_findings WHERE run_id=$1", [f.run])).rows
    const blocked = findings.find((r) => r.finding_kind === "BLOCKED_BY_META")
    expect(blocked).toBeDefined()
    expect(blocked.severity).toBe("HIGH")
    expect(blocked.status).toBe("OPEN")
    expect(blocked.confidence).toBe("HIGH")
    expect(String((blocked.evidence as { robotsMeta: string }).robotsMeta)).toContain("noindex")
    // Raw evidence is preserved per URL (append-only, never rewritten).
    const obs = (await pool.query("SELECT count(*)::int n FROM site_page_observations WHERE run_id=$1 AND collection_state='FETCHED'", [f.run])).rows[0].n as number
    expect(obs).toBe(2)
    const proposal = (await pool.query("SELECT fix_kind, classification, requires_approval, status FROM site_fix_proposals WHERE finding_id=$1", [blocked.id])).rows[0]
    expect(proposal.fix_kind).toBe("REMOVE_NOINDEX_META")
    expect(proposal.classification).toBe("APPROVAL_REQUIRED")
    expect(proposal.requires_approval).toBe(true)
    expect(proposal.status).toBe("PROPOSED")
  })

  it("reports VERIFIED_NOT_FIXED when production still shows the problem", async () => {
    const rows = (await pool.query(
      `SELECT f.id, f.business_id FROM site_findings f JOIN site_inspection_runs r ON r.id = f.run_id WHERE f.finding_kind='BLOCKED_BY_META' ORDER BY f.detected_at DESC LIMIT 1`,
    )).rows
    const target = rows[0] as { id: string; business_id: string }
    // Approve and apply the fix in the repo, but production still serves noindex.
    for (const to of ["AWAITING_APPROVAL", "APPROVED", "FIX_IN_PROGRESS", "FIX_APPLIED"]) {
      await advance(target.business_id, target.id, to)
    }
    const siteId = (await pool.query("SELECT site_target_id FROM site_findings WHERE id=$1", [target.id])).rows[0].site_target_id as string
    const second = (await pool.query("INSERT INTO site_inspection_runs (business_id, site_target_id) VALUES ($1,$2) RETURNING id", [target.business_id, siteId])).rows[0].id as string
    expect(await runUntilDone(second)).toBe("SUCCEEDED")
    const status = (await pool.query("SELECT status FROM site_findings WHERE id=$1", [target.id])).rows[0].status as string
    expect(status).toBe("VERIFIED_NOT_FIXED")
    const verification = (await pool.query("SELECT result FROM site_verifications WHERE finding_id=$1 ORDER BY checked_at DESC LIMIT 1", [target.id])).rows[0]
    expect(verification.result).toBe("VERIFIED_NOT_FIXED")
  })

  it("reports VERIFIED_FIXED after the live page stops exhibiting the issue", async () => {
    // Deploy the fix: production no longer serves noindex.
    bodies.set("/services/plumbing", { status: 200, contentType: "text/html", body: PLUMBING_FIXED })
    const rows = (await pool.query(
      `SELECT id, business_id FROM site_findings WHERE finding_kind='BLOCKED_BY_META' ORDER BY detected_at DESC LIMIT 1`,
    )).rows
    const target = rows[0] as { id: string; business_id: string }
    for (const to of ["OPEN", "AWAITING_APPROVAL", "APPROVED", "FIX_IN_PROGRESS", "FIX_APPLIED"]) {
      await advance(target.business_id, target.id, to)
    }
    const siteId = (await pool.query("SELECT site_target_id FROM site_findings WHERE id=$1", [target.id])).rows[0].site_target_id as string
    const third = (await pool.query("INSERT INTO site_inspection_runs (business_id, site_target_id) VALUES ($1,$2) RETURNING id", [target.business_id, siteId])).rows[0].id as string
    expect(await runUntilDone(third)).toBe("SUCCEEDED")
    const status = (await pool.query("SELECT status FROM site_findings WHERE id=$1", [target.id])).rows[0].status as string
    expect(status).toBe("VERIFIED_FIXED")
    const verification = (await pool.query("SELECT result, detail FROM site_verifications WHERE finding_id=$1 ORDER BY checked_at DESC LIMIT 1", [target.id])).rows[0]
    expect(verification.result).toBe("VERIFIED_FIXED")
    expect(String(verification.detail)).toContain("verified the fix on the live site")
    // History is preserved end to end (no silent rewrites).
    const history = (await pool.query("SELECT to_status FROM site_finding_events WHERE finding_id=$1 ORDER BY created_at ASC", [target.id])).rows.map((r) => r.to_status as string)
    expect(history[0]).toBe("OPEN")
    expect(history).toContain("VERIFIED_NOT_FIXED")
    expect(history[history.length - 1]).toBe("VERIFIED_FIXED")
  })

  it("rejects SSRF targets without issuing requests", async () => {
    const { business } = await (async () => {
      const account = (await pool.query("INSERT INTO accounts (name) VALUES ('SSRF fixture') RETURNING id")).rows[0].id as string
      const biz = (await pool.query("INSERT INTO businesses (account_id, name) VALUES ($1,'SsrfBiz') RETURNING id", [account])).rows[0].id as string
      return { business: biz }
    })()
    // Registration accepts syntax; the worker fails closed at fetch time and
    // never reports fake findings.
    const { site, run } = await Effect.runPromise(Effect.gen(function*() {
      const sites = yield* SiteTargetRepository
      const runs = yield* SiteRunRepository
      const s = yield* sites.create({ businessId: business, rootUrl: "http://127.0.0.1/", canonicalOrigin: "http://127.0.0.1", pathPrefix: "/" })
      const r = yield* runs.enqueue({ businessId: business, siteTargetId: s.id })
      return { site: s.id, run: r.id }
    }).pipe(Effect.provide(Repos)))
    void site
    expect(await runUntilDone(run)).toBe("FAILED")
    const count = (await pool.query("SELECT count(*)::int n FROM site_findings WHERE run_id=$1", [run])).rows[0].n as number
    expect(count).toBe(0)
  })
})
