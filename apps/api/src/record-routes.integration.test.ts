// Client record HTTP surface: session attribution, tenant isolation, input
// validation, and the public share URL (allowlist, headers, revocation,
// enumeration). Every agency, client and reviewer is a TEST fixture; the
// worker is simulated by persisting a Gemini-shaped observation directly.
// Requires TEST_DATABASE_URL (CI provides postgres; skipped otherwise).
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, BusinessRepositoryLive, ObservationRepository, ObservationRepositoryLive, RecordRepositoryLive, hostedMeasurementContext } from "@openrecord/db"
import { requireSession } from "./router.js"
import { recordApi } from "./record-routes.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("client record HTTP (TEST fixtures only)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AuthRepositoryLive, BusinessRepositoryLive, RecordRepositoryLive, ObservationRepositoryLive).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(recordApi(run => Effect.flatMap(requireSession, ({ session }) => run(session))), repos)
  const observations = Layer.mergeAll(ObservationRepositoryLive).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) })))
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })

  const agency = async () => {
    const account = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST Agency') RETURNING id")).rows[0].id as string
    const user = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`record-api-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [account, user])
    const session = (await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour') RETURNING id", [account, user])).rows[0].id as string
    return { account, user, session }
  }
  const call = (method: string, path: string, session?: string, body?: unknown) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { ...(session ? { cookie: `gp_session=${session}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const ok = async <T>(r: Response | Promise<Response>): Promise<T> => {
    const res = await r
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`)
    return await res.json() as T
  }
  const slotBody = (n: number) => ({ subject: "TEST Hotel", predicate: `Fact ${n}`, valueText: `Value ${n}`, valueType: "TEXT",
    sourceUrl: "https://client.test/facts", question: `What is fact ${n} at TEST Hotel?` })
  type View = { record: { slots: Array<{ slot: number; item: { id: string; approval: unknown } }>; runs: Array<{ id: string; status: string; checks: Array<{ id: string; status: string; observation: { id: string } | null }> }>; share: { publicId: string } | null } }
  /** A client with three approved slots. */
  const client = async (session: string) => {
    const { client: c } = await ok<{ client: { businessId: string } }>(call("POST", "/api/record/clients", session, { name: "TEST Hotel", websiteUrl: "https://client.test/", engagement: "FIXTURE" }))
    for (const n of [1, 2, 3]) {
      const { item } = await ok<{ item: { id: string } }>(call("PUT", `/api/record/clients/${c.businessId}/slots/${n}`, session, slotBody(n)))
      await ok(call("POST", `/api/record/clients/${c.businessId}/items/${item.id}/approve`, session))
    }
    return c.businessId
  }
  /** Simulates the worker answering one record check through Gemini. */
  const answer = async (businessId: string, checkRunId: string, text: string) => {
    await pool.query("UPDATE check_runs SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=$1 AND status='QUEUED'", [checkRunId])
    const run = (await pool.query("SELECT c.question_id, q.prompt FROM check_runs c JOIN buyer_questions q ON q.id=c.question_id WHERE c.id=$1", [checkRunId])).rows[0]
    const raw = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], modelVersion: "gemini-2.5-flash", nonce: randomUUID() })
    const collectedAt = new Date().toISOString()
    await Effect.runPromise(Effect.flatMap(ObservationRepository, o => o.create({
      businessId, checkRunId, provider: "gemini", requestedModel: "gemini-2.5-flash", observedModel: "gemini-2.5-flash", collectedAt, answerText: text,
      retrievalMode: "PROVIDER_GROUNDING", modelVersion: "gemini-2.5-flash", retrievalTool: "google_search",
      requestParameters: { model: "gemini-2.5-flash", tools: ["google_search"] }, rawResponse: JSON.parse(raw),
      rawDigest: createHash("sha256").update(raw).digest("hex"), rawBytesHex: Buffer.from(raw).toString("hex"), rawContentType: "application/json",
      providerMetadata: { responseId: "TEST-internal-response" }, synthetic: false, completeRun: true,
      measurementContext: hostedMeasurementContext({ businessId, questionId: run.question_id, checkRunId, prompt: run.prompt, provider: "gemini",
        requestedModel: "gemini-2.5-flash", observedModel: "gemini-2.5-flash", observedAt: collectedAt }),
      citations: [{ uri: "https://source.test/page", title: "source.test", position: 1, attributed: true }],
    })).pipe(Effect.provide(observations)))
  }
  /** Client with an answered, reviewed initial run and an active share. */
  const published = async () => {
    const a = await agency()
    const businessId = await client(a.session)
    await ok(call("POST", `/api/record/clients/${businessId}/runs`, a.session, {}))
    let view = await ok<View>(call("GET", `/api/record/clients/${businessId}`, a.session))
    for (const [i, c] of view.record.runs[0]!.checks.entries()) await answer(businessId, c.id, `TEST answer for check ${i + 1}`)
    view = await ok<View>(call("GET", `/api/record/clients/${businessId}`, a.session))
    for (const c of view.record.runs[0]!.checks) {
      await ok(call("POST", `/api/record/clients/${businessId}/judgments`, a.session, { observationId: c.observation!.id, decision: "CONTRADICTS", note: "TEST internal reviewer note" }))
    }
    const { share } = await ok<{ share: { publicId: string } }>(call("POST", `/api/record/clients/${businessId}/share`, a.session))
    return { ...a, businessId, publicId: share.publicId, view: await ok<View>(call("GET", `/api/record/clients/${businessId}`, a.session)) }
  }

  it("operator routes require a session and stay inside the agency account", async () => {
    const a = await agency(); const other = await agency()
    const businessId = await client(a.session)
    expect((await call("GET", "/api/record/clients")).status).toBe(401)
    expect((await call("GET", `/api/record/clients/${businessId}`)).status).toBe(401)
    for (const [method, path, body] of [
      ["GET", `/api/record/clients/${businessId}`, undefined],
      ["PUT", `/api/record/clients/${businessId}`, { name: "Hijack", websiteUrl: "https://evil.test/" }],
      ["PUT", `/api/record/clients/${businessId}/slots/1`, slotBody(1)],
      ["POST", `/api/record/clients/${businessId}/runs`, {}],
      ["POST", `/api/record/clients/${businessId}/share`, undefined],
      ["POST", `/api/record/clients/${businessId}/share/revoke`, undefined],
      ["POST", `/api/record/clients/${businessId}/actions`, { slot: null, note: "x" }],
    ] as const) expect((await call(method, path, other.session, body)).status, `${method} ${path}`).toBe(404)
    const listed = await ok<{ clients: Array<{ businessId: string }> }>(call("GET", "/api/record/clients", other.session))
    expect(listed.clients.map(c => c.businessId)).not.toContain(businessId)
    expect((await pool.query("SELECT name FROM businesses WHERE id=$1", [businessId])).rows[0].name).toBe("TEST Hotel")
  })

  it("human acts are attributed to the session; bodies cannot name a reviewer", async () => {
    const p = await published()
    const check = p.view.record.runs[0]!.checks[0]!
    const forged = await call("POST", `/api/record/clients/${p.businessId}/judgments`, p.session, { observationId: check.observation!.id, decision: "MATCHES", reviewedBy: randomUUID() })
    expect(forged.status).toBe(422)
    const rows = (await pool.query("SELECT reviewed_by_user_id FROM record_judgments WHERE business_id=$1", [p.businessId])).rows
    expect(rows.length).toBe(3)
    expect(rows.every(r => r.reviewed_by_user_id === p.user)).toBe(true)
    expect((await pool.query("SELECT approved_by_user_id FROM record_item_approvals WHERE business_id=$1", [p.businessId])).rows.every(r => r.approved_by_user_id === p.user)).toBe(true)
    // Another agency cannot judge this client's observation through its own client.
    const other = await agency(); const otherClient = await client(other.session)
    expect((await call("POST", `/api/record/clients/${otherClient}/judgments`, other.session, { observationId: check.observation!.id, decision: "MATCHES" })).status).toBe(404)
  })

  it("rejects unsafe or malformed input", async () => {
    const a = await agency()
    const businessId = await client(a.session)
    const base = `/api/record/clients/${businessId}`
    for (const [method, path, body] of [
      ["POST", "/api/record/clients", { name: "x", websiteUrl: "javascript:alert(1)" }],
      ["POST", "/api/record/clients", { name: " ", websiteUrl: "https://ok.test/" }],
      ["POST", "/api/record/clients", { name: "x", websiteUrl: "https://user:pass@ok.test/" }],
      ["PUT", `${base}/slots/4`, slotBody(1)],
      ["PUT", `${base}/slots/1`, { ...slotBody(1), sourceUrl: "data:text/html,hi" }],
      ["PUT", `${base}/slots/1`, { ...slotBody(1), validFrom: "2026-05-01T00:00:00Z", validUntil: "2026-04-01T00:00:00Z" }],
      ["PUT", `${base}/slots/1`, { ...slotBody(1), question: "" }],
      ["POST", `${base}/actions`, { slot: null, note: "x", performedAt: "2099-01-01T00:00:00Z" }],
      ["POST", `${base}/actions`, { slot: null, note: "x", links: ["javascript:alert(1)"] }],
      ["POST", `${base}/judgments`, { observationId: randomUUID(), decision: "SUPPORTED" }],
    ] as const) expect((await call(method, path, a.session, body)).status, JSON.stringify(body)).toBe(422)
  })

  it("refuses runs without approved facts and a second run while one is in flight", async () => {
    const a = await agency()
    const { client: c } = await ok<{ client: { businessId: string } }>(call("POST", "/api/record/clients", a.session, { name: "TEST Empty", websiteUrl: "https://client.test/" }))
    await ok(call("PUT", `/api/record/clients/${c.businessId}/slots/1`, a.session, slotBody(1)))
    const refused = await call("POST", `/api/record/clients/${c.businessId}/runs`, a.session, {})
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ _tag: "RecordRefused", reason: "NoApprovedFacts" })
    const businessId = await client(a.session)
    await ok(call("POST", `/api/record/clients/${businessId}/runs`, a.session, {}))
    const again = await call("POST", `/api/record/clients/${businessId}/runs`, a.session, {})
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ _tag: "RecordRefused", reason: "RunInProgress" })
  })

  it("the public URL serves only the allowlisted projection, with capability headers", async () => {
    const p = await published()
    expect(p.publicId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const res = await call("GET", `/api/public/records/${p.publicId}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("x-robots-tag")).toContain("noindex")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    const text = await res.text()
    const { record } = JSON.parse(text) as { record: { facts: Array<{ latest: { answer: string; judgment: { decision: string } } }>; disclosure: string } }
    expect(record.facts).toHaveLength(3)
    expect(record.facts.every(f => f.latest.judgment.decision === "CONTRADICTS" && f.latest.answer.startsWith("TEST answer for check"))).toBe(true)
    expect(record.disclosure).toContain("does not prove that the edit caused")
    for (const hidden of [p.businessId, p.account, p.user, p.session, "TEST internal reviewer note", "TEST-internal-response", "gemini-test-key",
      ...p.view.record.runs.flatMap(r => [r.id, ...r.checks.flatMap(c => [c.id, c.observation!.id])]), ...p.view.record.slots.map(s => s.item.id)]) {
      expect(text).not.toContain(hidden)
    }
    expect(text).not.toMatch(/score|percent/i)
    // The URL is stable: sharing again returns the same id.
    const again = await ok<{ share: { publicId: string } }>(call("POST", `/api/record/clients/${p.businessId}/share`, p.session))
    expect(again.share.publicId).toBe(p.publicId)
  })

  it("revoked, unknown and malformed ids are the same non-disclosing 404", async () => {
    const p = await published()
    await ok(call("POST", `/api/record/clients/${p.businessId}/share/revoke`, p.session))
    const bodies: string[] = []
    for (const id of [p.publicId, "A".repeat(43), "short", `${p.publicId}x`, "..%2F..%2Fetc", p.businessId]) {
      const res = await call("GET", `/api/public/records/${id}`)
      expect(res.status, id).toBe(404)
      expect(res.headers.get("cache-control")).toBe("no-store")
      bodies.push(await res.text())
    }
    expect(new Set(bodies).size).toBe(1)
    // A revoked id never comes back; a new share is a new id.
    const { share } = await ok<{ share: { publicId: string } }>(call("POST", `/api/record/clients/${p.businessId}/share`, p.session))
    expect(share.publicId).not.toBe(p.publicId)
    expect((await call("GET", `/api/public/records/${p.publicId}`)).status).toBe(404)
    expect((await call("GET", `/api/public/records/${share.publicId}`)).status).toBe(200)
    await expect(pool.query("UPDATE record_shares SET status='ACTIVE', revoked_at=NULL, revoked_by_user_id=NULL WHERE public_id=$1", [p.publicId])).rejects.toThrow()
    await expect(pool.query("DELETE FROM record_shares WHERE public_id=$1", [p.publicId])).rejects.toThrow()
  })
})
