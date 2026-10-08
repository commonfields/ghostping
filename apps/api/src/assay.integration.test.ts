import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { QuestionRepositoryLive, AuthRepositoryLive, AssayRepositoryLive, AssayReviewRepositoryLive, BusinessRepositoryLive } from "@openrecord/db"
import { requireSession } from "./router.js"
import { assayApi } from "./assay-routes.js"
const url = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("assay HTTP session identity (TEST fixtures only)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(QuestionRepositoryLive, AuthRepositoryLive, AssayRepositoryLive, AssayReviewRepositoryLive, BusinessRepositoryLive).pipe(
    Layer.provide(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(assayApi(run => Effect.flatMap(requireSession, ({ session }) => run(session))), repos)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })
  const fixture = async () => {
    const account = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST API assay') RETURNING id")).rows[0].id as string
    const user = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`api-assay-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [account, user])
    const session = (await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour') RETURNING id", [account, user])).rows[0].id as string
    const business = (await pool.query("INSERT INTO businesses(account_id,name) VALUES ($1,'TEST API business') RETURNING id", [account])).rows[0].id as string
    const evidence = (await pool.query("INSERT INTO raw_evidence(digest,content_text) VALUES ($1,'TEST public page') RETURNING id", [randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')])).rows[0].id as string
    const source = (await pool.query("INSERT INTO assay_sources(business_id,url,subject,requested_by,status,raw_evidence_id,fetched_text,fetched_at) VALUES ($1,'https://example.test/pricing','Northstar',$2,'FETCHED',$3,'Northstar costs $79 flat per month.',now()) RETURNING id", [business, user, evidence])).rows[0].id as string
    const fact = (await pool.query("INSERT INTO assay_proposed_facts(business_id,source_id,source_url,fact_type,subject,normalized,supporting_span) VALUES ($1,$2,'https://example.test/pricing','PRICE','Northstar',$3::jsonb,'Northstar costs $79 flat per month.') RETURNING id", [business, source, JSON.stringify({ amountMinor: 7900, currency: "USD", billingPeriod: "MONTH", unit: "ACCOUNT", qualifier: "EXACT" })])).rows[0].id as string
    return { user, session, business, fact }
  }
  const request = (path: string, session?: string, body?: unknown) => web.handler(new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { ...(session ? { cookie: `or_session=${session}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  it("requires a cookie session, scopes the business, and rejects forged review identities", async () => {
    const f = await fixture(); const other = await fixture()
    const path = `/api/businesses/${f.business}/assay/facts/${f.fact}/review`
    expect((await request(`/api/businesses/${f.business}/assay`)).status).toBe(401)
    expect((await request(`/api/businesses/${f.business}/assay`, other.session)).status).toBe(404)
    expect((await request(path, other.session, { decision: "CONFIRMED", reason: "TEST" })).status).toBe(404)
    expect((await request(path, f.session, { decision: "CONFIRMED", reason: "TEST", reviewed_by: other.user })).status).toBe(422)
    expect((await pool.query("SELECT reviewed_by FROM assay_proposed_facts WHERE id=$1", [f.fact])).rows[0].reviewed_by).toBeNull()
    expect((await request(path, f.session, { decision: "CONFIRMED", reason: "TEST session reviewer" })).status).toBe(200)
    const fact = (await pool.query("SELECT reviewed_by,reviewed_at,review_reason FROM assay_proposed_facts WHERE id=$1", [f.fact])).rows[0]
    expect(fact.reviewed_by).toBe(f.user); expect(fact.reviewed_at).not.toBeNull(); expect(fact.review_reason).toBe("TEST session reviewer")
    expect((await request(path, f.session, { decision: "AMBIGUOUS", reason: "TEST changed" })).status).toBe(409)
  })
  it("source approval uses the session identity and queues without network fetching", async () => {
    const f = await fixture()
    const path = `/api/businesses/${f.business}/assay/sources`
    const input = { url: "https://example.test/new-pricing", subject: "Northstar", planTerms: [], capabilityTerms: [] }
    expect((await request(path, f.session, { ...input, requestedBy: "forged" })).status).toBe(422)
    expect((await request(path, f.session, { ...input, url: "https://user:secret@example.test/pricing" })).status).toBe(422)
    const response = await request(path, f.session, input)
    expect(response.status).toBe(200)
    const { source } = await response.json() as { source: { id: string; status: string } }
    expect(source.status).toBe("QUEUED")
    expect((await pool.query("SELECT requested_by,raw_evidence_id FROM assay_sources WHERE id=$1", [source.id])).rows[0]).toEqual({ requested_by: f.user, raw_evidence_id: null })
  })
  it("retraction is session-attributed, body identities are refused, and it is write-once", async () => {
    const f = await fixture(); const other = await fixture()
    expect((await request(`/api/businesses/${f.business}/assay/facts/${f.fact}/review`, f.session, { decision: "CONFIRMED", reason: "TEST session reviewer" })).status).toBe(200)
    const path = `/api/businesses/${f.business}/assay/facts/${f.fact}/retract`
    expect((await request(path, undefined, { reason: "TEST" })).status).toBe(401)
    expect((await request(path, other.session, { reason: "TEST" })).status).toBe(404)
    for (const field of ["retracted_by", "retractedBy", "retracted_at", "userId"]) expect((await request(path, f.session, { reason: "TEST", [field]: other.user })).status).toBe(422)
    expect((await request(path, f.session, { reason: " " })).status).toBe(422)
    expect((await request(path, f.session, { reason: "TEST mistaken confirmation" })).status).toBe(200)
    expect((await pool.query("SELECT retracted_by,reason FROM assay_fact_retractions WHERE fact_id=$1", [f.fact])).rows[0]).toEqual({ retracted_by: f.user, reason: "TEST mistaken confirmation" })
    expect((await request(path, f.session, { reason: "TEST again" })).status).toBe(409)
  })
  it("synthetic mock assays are refused with 422 unless running tests or explicitly allowed", async () => {
    const f = await fixture()
    const question = (await pool.query("INSERT INTO buyer_questions(business_id,prompt) VALUES ($1,'TEST price question') RETURNING id", [f.business])).rows[0].id as string
    const path = `/api/businesses/${f.business}/assay/groups`
    const body = { questionId: question, provider: "mock", requestedModel: null, retrievalMode: "NONE", n: 1 }
    const saved = { node: process.env["NODE_ENV"], allow: process.env["ASSAY_ALLOW_SYNTHETIC"] }
    try {
      process.env["NODE_ENV"] = "production"
      delete process.env["ASSAY_ALLOW_SYNTHETIC"]
      const refused = await request(path, f.session, body)
      expect(refused.status).toBe(422)
      expect(await refused.json()).toEqual({ _tag: "SyntheticAssayDisabled" })
      process.env["ASSAY_ALLOW_SYNTHETIC"] = "1"
      expect((await request(path, f.session, body)).status).toBe(200)
    } finally {
      process.env["NODE_ENV"] = saved.node
      if (saved.allow === undefined) delete process.env["ASSAY_ALLOW_SYNTHETIC"]
      else process.env["ASSAY_ALLOW_SYNTHETIC"] = saved.allow
    }
    expect((await pool.query("SELECT count(*)::int n FROM assay_sample_groups WHERE business_id=$1", [f.business])).rows[0].n).toBe(1)
  })
})
