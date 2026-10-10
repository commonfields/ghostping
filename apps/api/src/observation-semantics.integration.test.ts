// Disposable PostgreSQL TEST fixtures. No provider or search-service calls.
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { HttpApp } from "@effect/platform"
import { Layer, Redacted, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import {
  AuthRepositoryLive, DiscoveryMatchRepositoryLive, DiscoveryObservationRepositoryLive,
  EvidenceLineageRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive,
  RecordRepositoryLive, SourceTargetRepositoryLive,
} from "@openrecord/db"
import { ProviderCatalogResponse, ProviderDailyAnswer } from "@openrecord/contracts"
import pg from "pg"
import { makeRouter, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("hosted observation semantics (TEST fixtures)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(
    AuthRepositoryLive, RecordRepositoryLive,
    InterventionRepositoryLive, InterventionBindingRepositoryLive, SourceTargetRepositoryLive,
    EvidenceLineageRepositoryLive, DiscoveryObservationRepositoryLive, DiscoveryMatchRepositoryLive,
    RepoLayers.AssayRepositoryLive,
    RepoLayers.AssayReviewRepositoryLive,
    RepoLayers.BusinessRepositoryLive,
    RepoLayers.FactRepositoryLive,
    RepoLayers.QuestionRepositoryLive,
    RepoLayers.CheckRunRepositoryLive,
    RepoLayers.ObservationRepositoryLive,
    RepoLayers.ClaimRepositoryLive,
    RepoLayers.JudgmentRepositoryLive,
    RepoLayers.ReobservationIntentRepositoryLive,
    RepoLayers.ReobservationRepositoryLive,
    RepoLayers.ProductReadRepositoryLive,
    RepoLayers.DiscoveryScopeRepositoryLive,
    RepoLayers.DiscoveryRunRepositoryLive,
    RepoLayers.DiscoveryFrontierRepositoryLive,
    RepoLayers.SiteTargetRepositoryLive,
    RepoLayers.SiteRunRepositoryLive,
    RepoLayers.SitePageObservationRepositoryLive,
    RepoLayers.SiteFindingRepositoryLive,
    RepoLayers.SiteFindingEventRepositoryLive,
    RepoLayers.SiteFixProposalRepositoryLive,
    RepoLayers.SiteMutationRepositoryLive,
    RepoLayers.SiteVerificationRepositoryLive,
    RepoLayers.SiteOperatorEventRepositoryLive,
    RepoLayers.SiteGscRepositoryLive,
  ).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
  )
  const web = HttpApp.toWebHandlerLayer(makeRouter(), repos)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { vi.unstubAllEnvs(); await web.dispose(); await pool.end() })

  const fixture = async () => {
    const account = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST observation semantics') RETURNING id")).rows[0].id as string
    const user = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`semantics-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [account, user])
    const session = (await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour') RETURNING id", [account, user])).rows[0].id as string
    const business = (await pool.query("INSERT INTO businesses(account_id,name) VALUES ($1,'TEST Brand') RETURNING id", [account])).rows[0].id as string
    const question = (await pool.query("INSERT INTO buyer_questions(business_id,prompt) VALUES ($1,'TEST opening time?') RETURNING id", [business])).rows[0].id as string
    return { business, question, session }
  }
  const get = (path: string, session?: string) => web.handler(new Request(`http://localhost${path}`, { headers: session ? { cookie: `or_session=${session}` } : {} }))

  it("keeps the expanded provider catalog authenticated", async () => {
    expect((await get("/api/providers")).status).toBe(401)
    const f = await fixture()
    const response = await get("/api/providers", f.session)
    expect(response.status).toBe(200)
    const body = await response.json()
    const catalog = Schema.decodeUnknownSync(ProviderCatalogResponse)(body)
    expect(catalog.providers.map(p => p.id)).toEqual(["mock", "9router", "gemini"])
    expect(catalog.providers.every(p => p.workerAvailability === "UNKNOWN")).toBe(true)
  })

  it("counts answers without brand mentions and preserves empty collection buckets and tenant isolation", async () => {
    const f = await fixture()
    const foreign = await fixture()
    for (const owner of [f, foreign]) {
      const run = (await pool.query("INSERT INTO check_runs(business_id,question_id,provider,status) VALUES ($1,$2,'mock','SUCCEEDED') RETURNING id", [owner.business, owner.question])).rows[0].id as string
      const text = "The opening time is unknown." // Deliberately no TEST Brand mention.
      const raw = JSON.stringify({ answer: text, fixture: randomUUID() })
      const digest = createHash("sha256").update(raw).digest("hex")
      const evidence = (await pool.query("INSERT INTO raw_evidence(digest,content_text) VALUES ($1,$2) RETURNING id", [digest, raw])).rows[0].id as string
      await pool.query("INSERT INTO observations(business_id,check_run_id,provider,collected_at,answer_text,retrieval_mode,raw_evidence_id,raw_digest,synthetic) VALUES ($1,$2,'mock',now()-interval '1 day',$3,'unknown',$4,$5,true)", [owner.business, run, text, evidence, digest])
    }
    const response = await get(`/api/businesses/${f.business}/analytics?days=7`, f.session)
    expect(response.status).toBe(200)
    const { analytics } = await response.json() as { analytics: { providerDaily: unknown[] } }
    const rows = analytics.providerDaily.map(row => Schema.decodeUnknownSync(ProviderDailyAnswer, { onExcessProperty: "error" })(row))
    expect(rows.reduce((n, row) => n + row.answers, 0)).toBe(1)
    expect(rows.some(row => row.answers === 0)).toBe(true)
    expect(analytics.providerDaily.every(row => !Object.hasOwn(row as object, "mentions"))).toBe(true)
    expect((await get(`/api/businesses/${foreign.business}/analytics?days=7`, f.session)).status).toBe(404)
  })

  it("does not report LIVE or CONNECTED Search Console from credentials alone", async () => {
    const f = await fixture()
    vi.stubEnv("GOOGLE_SEARCH_CONSOLE_CLIENT_ID", "TEST-client-id")
    vi.stubEnv("GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET", "TEST-client-secret")
    try {
      const response = await get(`/api/businesses/${f.business}/search/gsc`, f.session)
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({ status: "BLOCKED_NOT_IMPLEMENTED", source: "FIXTURE" })
      expect(JSON.stringify(body)).not.toContain("TEST-client-secret")
    } finally { vi.unstubAllEnvs() }
  })
})
