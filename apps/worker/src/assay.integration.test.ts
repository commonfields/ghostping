import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Redacted, Schedule } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import {
  AssayRepository, AssayRepositoryLive, AssayReviewRepository, AssayReviewRepositoryLive,
  CheckRunRepositoryLive, ObservationRepositoryLive, ProviderAttemptEvidenceRepositoryLive, QuestionRepositoryLive,
  type AssayFactRow, type AssayGroupRow, type Session, type DbEffect,
} from "@openrecord/db"
import { ASSAY_RETRIEVAL_LIMITATION } from "@openrecord/contracts"
import { makeMockProviderLive, NineRouterProvider, ProviderRegistryLive, ProviderUnavailable, rawEvidence, type Citation, type ProviderRequest } from "@openrecord/providers"
import { type HttpTransport, safeFetch, proposeAssayFacts } from "@openrecord/representation"
import { AssayRunner, makeAssayRunnerLive } from "./assay-runner.js"
import { CheckRunner, makeCheckRunnerLive } from "./check-runner.js"

const url = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const html = readFileSync(new URL("../../../fixtures/prospect-assay-v1/pricing.html", import.meta.url), "utf8")
type Scripted = string | null | { answer: string; citations: readonly (typeof Citation.Type)[] }

// One deterministic answer script shared by the synthetic mock and the
// test-only retrieval provider, keyed by prompt and sample number.
const script = (request: ProviderRequest): Scripted => {
  const p = request.prompt
  const n = request.sampleNumber ?? 0
  if (p.includes("partial") && n === 5) return null
  if (p.includes("allfailed")) return null
  if (p.includes("annual")) return "Northstar costs $49 per year."
  if (p.includes("intermittent")) return n <= 2 ? "Northstar costs $49 flat per month." : "Northstar costs $79 flat per month."
  if (p.includes("unclear")) return n === 5 ? "Northstar costs $49 flat per year." : "Northstar costs $49 flat per month."
  // B1 reproduction: every answer is correct about Northstar.
  if (p.includes("b1contrast")) return n <= 3 ? "HubSpot supports Salesforce, while Northstar does not." : "Northstar does not support Salesforce."
  if (p.includes("b1nolonger")) return "Northstar no longer supports Salesforce."
  // B2 reproduction: every answer is incomparable with $79 flat/month/EXACT.
  if (p.includes("b2mix")) return ["Northstar starts at $29 flat per month.", "Northstar costs $29 flat per month, billed annually.",
    "Northstar costs US$29 flat per month.", "Northstar costs $79K flat per month.", "In 2019, Northstar cost $29 flat per month."][n - 1]!
  return { answer: n === 5 ? "Northstar costs $79 flat per month." : "Northstar costs $49 flat per month.",
    citations: [{ uri: "https://assay.test/old", title: "TEST stale source", position: 1, attributed: false }] }
}

// TEST-ONLY provider layer, never shipped: it stands in for a real
// retrieval-enabled engine (requestedModel selects the reported mode) and
// reports synthetic=false so the verification-eligible path can be tested.
const TEST_ONLY_WEB_SEARCH = "test-only-web-search"
const TEST_ONLY_NONE = "test-only-no-retrieval"
const TEST_ONLY_UNKNOWN = "test-only-unknown-retrieval"
const testOnlyRetrievalProviderLayer = Layer.succeed(NineRouterProvider, {
  observe: request => Effect.gen(function*() {
    const scripted = script(request)
    if (scripted === null) return yield* Effect.fail(new ProviderUnavailable({}))
    const answer = typeof scripted === "string" ? scripted : scripted.answer
    const citations = typeof scripted === "string" ? [] : scripted.citations
    const retrievalMode = request.requestedModel === TEST_ONLY_WEB_SEARCH ? "WEB_SEARCH" as const : request.requestedModel === TEST_ONLY_NONE ? "NONE" as const : "unknown" as const
    const rawResponse = { provider: "test-only", answer, retrievalMode, citations }
    return {
      ...rawEvidence(new TextEncoder().encode(JSON.stringify(rawResponse)), "application/json"),
      provider: "9router", requestedModel: request.requestedModel, observedModel: request.requestedModel,
      collectedAt: new Date().toISOString(), answerText: answer, retrievalMode, modelVersion: null,
      retrievalTool: retrievalMode === "WEB_SEARCH" ? "test-only-search" : null, requestParameters: { model: request.requestedModel },
      citations, rawResponse, providerMetadata: null, synthetic: false,
    }
  }),
})

suite("Phase 2 deterministic prospect assay gate (TEST reviewer only)", () => {
  let pool: pg.Pool
  const fetchedUrls: string[] = []
  const pages: Record<string, string> = {
    "/old": `<p>Other costs $490 per month.</p><p>${"Unrelated context. ".repeat(20)}</p><p>Northstar costs $49 flat per month.</p>`,
    "/no-salesforce": "<p>Northstar does not support Salesforce.</p>",
    "/later": "<p>Northstar costs $99 flat per month.</p>",
    "/dup": "<p>Northstar costs $79 flat per month.</p>",
  }
  const transport: HttpTransport = {
    lookup: async host => host === "127.0.0.1" ? ["127.0.0.1"] : ["93.184.216.34"],
    fetch: async requested => {
      fetchedUrls.push(requested)
      const page = Object.keys(pages).find(path => new URL(requested).pathname.endsWith(path))
      return { status: 200, headers: { "content-type": "text/html" }, peerIp: "93.184.216.34", body: new TextEncoder().encode(page ? pages[page]! : html) }
    },
  }
  const PgLive = PgClient.layer({ url: Redacted.make(url) })
  const Repos = Layer.mergeAll(AssayRepositoryLive, AssayReviewRepositoryLive, CheckRunRepositoryLive, QuestionRepositoryLive,
    ObservationRepositoryLive, ProviderAttemptEvidenceRepositoryLive).pipe(Layer.provide(PgLive))
  const Providers = ProviderRegistryLive.pipe(Layer.provide(makeMockProviderLive(script)), Layer.provide(testOnlyRetrievalProviderLayer))
  const CheckLive = makeCheckRunnerLive(Schedule.recurs(0)).pipe(Layer.provide(Repos), Layer.provide(Providers))
  const AssayLive = makeAssayRunnerLive({ transport }).pipe(Layer.provide(Repos))
  // One memoized runtime (one connection pool) for the whole file instead
  // of a fresh pool per call, which churned hundreds of connections.
  const runtime = ManagedRuntime.make(Layer.mergeAll(Repos, CheckLive, AssayLive))
  const repo = <A>(fn: (r: AssayRepository["Type"]) => DbEffect<A>) => runtime.runPromise(Effect.flatMap(AssayRepository, fn))
  // Every claim and sweep is scoped to the fixture's business: suites share
  // one database, so a global claim could take another file's work.
  const assayOnce = (businessId: string) => runtime.runPromise(Effect.flatMap(AssayRunner, r => r.runOnce({ businessId })))
  const checkOnce = (businessId: string) => runtime.runPromise(Effect.flatMap(CheckRunner, r => r.runOnce({ businessId })))
  const derive = (businessId: string) => repo(r => r.derive(businessId))
  const review = <A>(fn: (r: AssayReviewRepository["Type"]) => DbEffect<A>) => runtime.runPromise(Effect.flatMap(AssayReviewRepository, fn))
  const reviewFact = (session: Session, b: string, fact: string) => review(r => r.reviewFact(session, b, fact, "CONFIRMED", "TEST reviewer confirmed fixture public page"))
  const reviewFinding = (session: Session, b: string, finding: string) => review(r => r.reviewFinding(session, b, finding, "REVIEWED_CORRECT", "TEST reviewer checked deterministic evidence"))
  const retractFact = (session: Session, b: string, fact: string) => review(r => r.retractFact(session, b, fact, "TEST reviewer withdrew a mistaken confirmation"))
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    expect(Number((await pool.query("SHOW server_version_num")).rows[0].server_version_num)).toBeGreaterThanOrEqual(160000)
  })
  afterAll(async () => { await runtime.dispose(); await pool.end() })
  const finishSource = async (businessId: string, sourceId: string) => {
    for (let i = 0; i < 50; i++) {
      await assayOnce(businessId)
      const status = (await pool.query("SELECT status FROM assay_sources WHERE id=$1", [sourceId])).rows[0].status as string
      if (status === "FETCHED" || status === "FAILED") return status
    }
    throw new Error("TEST source did not finish")
  }
  const addSource = async (f: { businessId: string; session: Session }, path: string, terms: { planTerms?: string[]; capabilityTerms?: string[] } = {}) => {
    const source = await repo(r => r.registerSource({ businessId: f.businessId, url: `https://assay.test/${f.businessId}${path}`, subject: "Northstar",
      planTerms: terms.planTerms ?? [], capabilityTerms: terms.capabilityTerms ?? [], requestedBy: f.session.userId }))
    expect(await finishSource(f.businessId, source.id)).toBe("FETCHED")
    return source
  }
  const fixture = async (prompt = "How much does Northstar cost?") => {
    const accountId = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST assay') RETURNING id")).rows[0].id as string
    const userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only-not-a-password') RETURNING id", [`assay-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [accountId, userId])
    const businessId = (await pool.query("INSERT INTO businesses(account_id,name) VALUES ($1,'TEST Northstar') RETURNING id", [accountId])).rows[0].id as string
    const questionId = (await pool.query("INSERT INTO buyer_questions(business_id,prompt) VALUES ($1,$2) RETURNING id", [businessId, prompt])).rows[0].id as string
    const session = { accountId, userId }
    const source = await addSource({ businessId, session }, "/pricing", { planTerms: ["Pro"], capabilityTerms: ["Salesforce"] })
    const facts = await repo(r => r.facts(businessId)) as readonly AssayFactRow[]
    expect(facts).toHaveLength(3)
    expect(facts.every(f => f.status === "PROPOSED")).toBe(true)
    const price = facts.find(f => f.fact_type === "PRICE")!
    const capability = facts.find(f => f.fact_type === "BOOLEAN_CAPABILITY")!
    return { businessId, questionId, source, price, capability, session }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const enqueue = async (f: Fixture, options: { provider?: "mock" | "9router"; model?: string; retrievalMode?: AssayGroupRow["retrieval_mode"]; n?: number } = {}) =>
    await repo(r => r.enqueueGroup({ businessId: f.businessId, questionId: f.questionId, provider: options.provider ?? "mock",
      requestedModel: options.model ?? null, retrievalMode: options.retrievalMode ?? "WEB_SEARCH", ...(options.n === undefined ? {} : { n: options.n }) })) as AssayGroupRow
  const drain = async (businessId: string) => { for (let i = 0; i < 100; i++) if (!await checkOnce(businessId)) return; throw new Error("TEST queue did not drain") }
  const sample = async (f: Fixture, options: Parameters<typeof enqueue>[1] = {}) => { const g = await enqueue(f, options); await drain(f.businessId); await derive(f.businessId); return g }
  const findings = async (businessId: string) => await repo(r => r.findings(businessId))
  const comparisons = async (factId: string) => (await pool.query(
    "SELECT j.comparison FROM assay_sample_judgments j JOIN observations o ON o.id=j.observation_id JOIN check_runs r ON r.id=o.check_run_id WHERE j.proposed_fact_id=$1 ORDER BY r.sample_number", [factId])).rows.map(r => r.comparison as string)

  it("registers, safely fetches, proposes, confirms, samples, derives, queues and reviews 4/5 on a retrieval-enabled engine", async () => {
    const f = await fixture()
    expect((await pool.query("SELECT requested_by,extractor_version,raw_evidence_id FROM assay_sources WHERE id=$1", [f.source.id])).rows[0]).toMatchObject({ requested_by: f.session.userId, extractor_version: "assay-deterministic-v2" })
    expect((await pool.query("SELECT * FROM assay_proposed_facts WHERE id=$1", [f.price.id])).rows[0].reviewed_by).toBeNull()
    await derive(f.businessId)
    expect(await findings(f.businessId)).toEqual([])
    expect(await reviewFact(f.session, f.businessId, f.price.id)).toBe(true)
    const oldSource = await addSource(f, "/old")
    // Requested NONE: the registry gates requested modes by declared
    // capabilities (9router accepts NONE only); the test-only engine reports
    // the observed mode from requestedModel.
    const group = await enqueue(f, { provider: "9router", model: TEST_ONLY_WEB_SEARCH, retrievalMode: "NONE" })
    expect(group.n).toBe(5)
    expect((await pool.query("SELECT sample_number FROM check_runs WHERE assay_sample_group_id=$1 ORDER BY sample_number", [group.id])).rows.map(r => r.sample_number)).toEqual([1, 2, 3, 4, 5])
    await drain(f.businessId)
    await derive(f.businessId)
    await derive(f.businessId)
    const queue = await findings(f.businessId)
    expect(queue).toHaveLength(1)
    const finding = queue[0]!
    expect(finding).toMatchObject({ verdict: "CONFIRMED", sample_count: 5, requested_n: 5, contradict_count: 4, unclear_count: 0,
      retrieval_class: "RETRIEVAL_ENABLED", verification_eligible: true, retrieval_limitation: null })
    expect(finding.samples).toHaveLength(5)
    const diagnosis = finding.source_diagnosis as { likelySources: Array<{ label: string; url: string; supportingVariants: string[]; supportingSpans: string[] }> }
    expect(diagnosis.likelySources).toHaveLength(1)
    expect(diagnosis.likelySources[0]).toMatchObject({ label: "LIKELY_SOURCE", url: oldSource.url, supportingVariants: ["$49"] })
    expect(diagnosis.likelySources[0]!.supportingSpans.every(span => !span.includes("$490"))).toBe(true)
    for (const s of finding.samples) { expect(String(s.answer)).toContain(String(s.supportingSpan)); expect(s.retrievalMode).toBe("WEB_SEARCH"); expect(s.synthetic).toBe(false) }
    expect((await pool.query("SELECT count(*)::int n FROM assay_sample_judgments WHERE proposed_fact_id=$1", [f.price.id])).rows[0].n).toBe(5)
    expect((await pool.query("SELECT count(*)::int n FROM assay_findings WHERE sample_group_id=$1", [group.id])).rows[0].n).toBe(1)
    expect(await reviewFinding(f.session, f.businessId, finding.id)).toBe(true)
    expect(await findings(f.businessId)).toEqual([])
    expect(await reviewFinding(f.session, f.businessId, finding.id)).toBe(false)
    expect((await pool.query("SELECT reviewed_by,review_reason FROM assay_finding_reviews WHERE finding_id=$1", [finding.id])).rows[0]).toMatchObject({ reviewed_by: f.session.userId, review_reason: "TEST reviewer checked deterministic evidence" })
    await expect(pool.query("UPDATE assay_finding_reviews SET review_reason='changed' WHERE finding_id=$1", [finding.id])).rejects.toThrow()
    await expect(pool.query("DELETE FROM assay_finding_reviews WHERE finding_id=$1", [finding.id])).rejects.toThrow()
  })
  it("M1 mock observations are synthetic, report unknown retrieval despite WEB_SEARCH, and are never eligible", async () => {
    const f = await fixture()
    await reviewFact(f.session, f.businessId, f.price.id)
    const group = await sample(f, { retrievalMode: "WEB_SEARCH" })
    const modes = (await pool.query("SELECT o.retrieval_mode,o.synthetic FROM observations o JOIN check_runs r ON r.id=o.check_run_id WHERE r.assay_sample_group_id=$1", [group.id])).rows
    expect(modes).toHaveLength(5)
    for (const row of modes) expect(row).toEqual({ retrieval_mode: "unknown", synthetic: true })
    expect((await findings(f.businessId))[0]).toMatchObject({ retrieval_class: "SYNTHETIC_FIXTURE", verification_eligible: false, retrieval_limitation: ASSAY_RETRIEVAL_LIMITATION })
  })
  it("M1 synthetic group creation is gated outside tests unless explicitly allowed", async () => {
    const f = await fixture()
    const saved = { node: process.env["NODE_ENV"], allow: process.env["ASSAY_ALLOW_SYNTHETIC"] }
    try {
      process.env["NODE_ENV"] = "production"
      delete process.env["ASSAY_ALLOW_SYNTHETIC"]
      await expect(enqueue(f)).rejects.toThrow()
      expect((await pool.query("SELECT count(*)::int n FROM assay_sample_groups WHERE business_id=$1", [f.businessId])).rows[0].n).toBe(0)
      process.env["ASSAY_ALLOW_SYNTHETIC"] = "1"
      expect((await enqueue(f)).n).toBe(5)
    } finally {
      process.env["NODE_ENV"] = saved.node
      if (saved.allow === undefined) delete process.env["ASSAY_ALLOW_SYNTHETIC"]
      else process.env["ASSAY_ALLOW_SYNTHETIC"] = saved.allow
    }
  })
  it("M6 NONE is stale parametric knowledge and unknown retrieval is UNKNOWN; both carry the limitation", async () => {
    const f = await fixture()
    await reviewFact(f.session, f.businessId, f.price.id)
    await sample(f, { provider: "9router", model: TEST_ONLY_NONE, retrievalMode: "NONE" })
    expect((await findings(f.businessId))[0]).toMatchObject({ retrieval_class: "STALE_PARAMETRIC_KNOWLEDGE", verification_eligible: false, retrieval_limitation: ASSAY_RETRIEVAL_LIMITATION })
    const u = await fixture()
    await reviewFact(u.session, u.businessId, u.price.id)
    await sample(u, { provider: "9router", model: TEST_ONLY_UNKNOWN, retrievalMode: "NONE" })
    expect((await findings(u.businessId))[0]).toMatchObject({ retrieval_class: "UNKNOWN", verification_eligible: false, retrieval_limitation: ASSAY_RETRIEVAL_LIMITATION })
  })
  it("defers all judgments until confirmation, even when observations already completed", async () => {
    const f = await fixture()
    await sample(f)
    expect((await pool.query("SELECT count(*)::int n FROM assay_sample_judgments WHERE business_id=$1", [f.businessId])).rows[0].n).toBe(0)
    expect(await findings(f.businessId)).toEqual([])
    expect(await reviewFact(f.session, f.businessId, f.price.id)).toBe(true)
    await derive(f.businessId)
    expect(await findings(f.businessId)).toHaveLength(1)
  })
  it("M2 answers collected before the page snapshot are never judged", async () => {
    const f = await fixture()
    const group = await sample(f, { provider: "9router", model: TEST_ONLY_WEB_SEARCH, retrievalMode: "NONE" })
    const later = await addSource(f, "/later")
    const laterFact = (await repo(r => r.facts(f.businessId)) as readonly AssayFactRow[]).find(p => p.source_id === later.id)!
    expect(laterFact.normalized).toMatchObject({ amountMinor: 9900 })
    const snapshot = (await pool.query("SELECT p.valid_from,s.fetched_at FROM assay_proposed_facts p JOIN assay_sources s ON s.id=p.source_id WHERE p.id=$1", [laterFact.id])).rows[0]
    expect(snapshot.valid_from.toISOString()).toBe(snapshot.fetched_at.toISOString())
    expect(await reviewFact(f.session, f.businessId, laterFact.id)).toBe(true)
    await derive(f.businessId)
    expect(await comparisons(laterFact.id)).toEqual([])
    expect(await findings(f.businessId)).toEqual([])
    const obs = (await pool.query("SELECT o.id,o.answer_text FROM observations o JOIN check_runs r ON r.id=o.check_run_id WHERE r.assay_sample_group_id=$1 LIMIT 1", [group.id])).rows[0]
    await expect(pool.query("INSERT INTO assay_sample_judgments (business_id,observation_id,proposed_fact_id,comparison,supporting_span,extractor_kind,extractor_version,structured_output) VALUES ($1,$2,$3,'CONTRADICTS',$4,'DETERMINISTIC','TEST','{}')",
      [f.businessId, obs.id, laterFact.id, obs.answer_text])).rejects.toThrow(/after snapshot/)
  })
  it("B1 contrast answers that are all correct produce zero contradictions end to end", async () => {
    const f = await fixture("b1contrast Does Northstar integrate with Salesforce?")
    await addSource(f, "/no-salesforce", { capabilityTerms: ["Salesforce"] })
    const negative = (await repo(r => r.facts(f.businessId)) as readonly AssayFactRow[]).find(p => p.fact_type === "BOOLEAN_CAPABILITY" && (p.normalized as { value: boolean }).value === false)!
    expect(await reviewFact(f.session, f.businessId, negative.id)).toBe(true)
    await sample(f, { provider: "9router", model: TEST_ONLY_WEB_SEARCH, retrievalMode: "NONE" })
    expect(await comparisons(negative.id)).toEqual(["UNCLEAR", "UNCLEAR", "UNCLEAR", "MATCHES", "MATCHES"])
    expect(await findings(f.businessId)).toEqual([])
    const t = await fixture("b1nolonger Does Northstar integrate with Salesforce?")
    expect(await reviewFact(t.session, t.businessId, t.capability.id)).toBe(true)
    await sample(t, { provider: "9router", model: TEST_ONLY_WEB_SEARCH, retrievalMode: "NONE" })
    expect(await comparisons(t.capability.id)).toEqual(Array(5).fill("UNCLEAR"))
    expect(await findings(t.businessId)).toEqual([])
  })
  it("B2 incomparable prices are UNCLEAR end to end and produce no finding", async () => {
    const f = await fixture("b2mix Northstar price")
    await reviewFact(f.session, f.businessId, f.price.id)
    await sample(f, { provider: "9router", model: TEST_ONLY_WEB_SEARCH, retrievalMode: "NONE" })
    expect(await comparisons(f.price.id)).toEqual(Array(5).fill("UNCLEAR"))
    expect(await findings(f.businessId)).toEqual([])
  })
  it("M3 retraction withdraws a confirmed fact from the queue and from new derivation without rewriting history", async () => {
    const f = await fixture()
    expect(await reviewFact(f.session, f.businessId, f.price.id)).toBe(true)
    await sample(f)
    const finding = (await findings(f.businessId))[0]!
    expect(await retractFact({ ...f.session, userId: "agent-placeholder" }, f.businessId, f.price.id)).toBe(false)
    expect(await retractFact(f.session, f.businessId, f.capability.id)).toBe(false) // still PROPOSED
    expect(await retractFact(f.session, f.businessId, f.price.id)).toBe(true)
    expect(await retractFact(f.session, f.businessId, f.price.id)).toBe(false)
    expect(await findings(f.businessId)).toEqual([])
    expect((await pool.query("SELECT fact_retracted FROM assay_finding_history WHERE id=$1", [finding.id])).rows[0].fact_retracted).toBe(true)
    expect((await pool.query("SELECT count(*)::int n FROM assay_sample_judgments WHERE proposed_fact_id=$1", [f.price.id])).rows[0].n).toBe(5)
    await sample(f)
    expect((await pool.query("SELECT count(*)::int n FROM assay_sample_judgments WHERE proposed_fact_id=$1", [f.price.id])).rows[0].n).toBe(5)
    expect((await pool.query("SELECT count(*)::int n FROM assay_findings WHERE proposed_fact_id=$1", [f.price.id])).rows[0].n).toBe(1)
    const row = (await pool.query("SELECT retracted_by,retracted_at,reason FROM assay_fact_retractions WHERE fact_id=$1", [f.price.id])).rows[0]
    expect(row).toMatchObject({ retracted_by: f.session.userId, reason: "TEST reviewer withdrew a mistaken confirmation" })
    for (const sql of ["UPDATE assay_fact_retractions SET reason='changed' WHERE fact_id=$1", "DELETE FROM assay_fact_retractions WHERE fact_id=$1"]) await expect(pool.query(sql, [f.price.id])).rejects.toThrow()
    // retracted_at is server time; a supplied timestamp is ignored.
    expect(await reviewFact(f.session, f.businessId, f.capability.id)).toBe(true)
    await pool.query("INSERT INTO assay_fact_retractions (fact_id,business_id,retracted_by,retracted_at,reason) VALUES ($1,$2,$3,'1999-01-01','TEST')", [f.capability.id, f.businessId, f.session.userId])
    expect((await pool.query("SELECT retracted_at > now()-interval '1 hour' AS fresh FROM assay_fact_retractions WHERE fact_id=$1", [f.capability.id])).rows[0].fresh).toBe(true)
    const other = await fixture()
    await expect(pool.query("INSERT INTO assay_fact_retractions (fact_id,business_id,retracted_by,reason) VALUES ($1,$2,$3,'TEST')", [f.price.id, other.businessId, other.session.userId])).rejects.toThrow()
  })
  it("M4 the database admits findings only for active confirmed facts with recomputed counts", async () => {
    const f = await fixture()
    const group = await sample(f)
    const insertFinding = (factId: string, count: number, contradictions: number, verdict: string) => pool.query(
      "INSERT INTO assay_findings (business_id,sample_group_id,proposed_fact_id,sample_count,requested_n,contradict_count,unclear_count,verdict,retrieval_class,verification_eligible) VALUES ($1,$2,$3,$4,5,$5,0,$6,'SYNTHETIC_FIXTURE',false)",
      [f.businessId, group.id, factId, count, contradictions, verdict])
    await expect(insertFinding(f.price.id, 5, 4, "CONFIRMED")).rejects.toThrow(/active confirmed fact/)
    await review(r => r.reviewFact(f.session, f.businessId, f.price.id, "AMBIGUOUS", "TEST reviewer could not tell"))
    await expect(insertFinding(f.price.id, 1, 1, "CONFIRMED")).rejects.toThrow(/active confirmed fact/)
    const c = await fixture()
    await reviewFact(c.session, c.businessId, c.price.id)
    const cGroup = await enqueue(c)
    await drain(c.businessId)
    const obs = (await pool.query("SELECT o.id FROM observations o JOIN check_runs r ON r.id=o.check_run_id WHERE r.assay_sample_group_id=$1 LIMIT 1", [cGroup.id])).rows[0].id as string
    await expect(pool.query("INSERT INTO assay_sample_judgments (business_id,observation_id,proposed_fact_id,comparison,supporting_span,extractor_kind,extractor_version,structured_output) VALUES ($1,$2,$3,'CONTRADICTS','','DETERMINISTIC','TEST','{}')",
      [c.businessId, obs, c.price.id])).rejects.toThrow()
    await derive(c.businessId)
    const real = (await findings(c.businessId))[0]!
    expect(real).toMatchObject({ sample_count: 5, contradict_count: 4 })
    // Forged counts or classification are refused on recomputation (the
    // BEFORE INSERT trigger runs ahead of the uniqueness check).
    await expect(pool.query("INSERT INTO assay_findings (business_id,sample_group_id,proposed_fact_id,sample_count,requested_n,contradict_count,unclear_count,verdict,retrieval_class,verification_eligible) VALUES ($1,$2,$3,5,5,5,0,'CONFIRMED','RETRIEVAL_ENABLED',true)",
      [c.businessId, cGroup.id, c.price.id])).rejects.toThrow(/do not match evidence/)
  })
  it("review timestamps are server time; supplied values are ignored", async () => {
    const f = await fixture()
    await pool.query("UPDATE assay_proposed_facts SET status='CONFIRMED',reviewed_by=$2,reviewed_at='1999-01-01',review_reason='TEST direct reviewer' WHERE id=$1", [f.price.id, f.session.userId])
    expect((await pool.query("SELECT reviewed_at > now()-interval '1 hour' AS fresh FROM assay_proposed_facts WHERE id=$1", [f.price.id])).rows[0].fresh).toBe(true)
    await sample(f)
    const finding = (await findings(f.businessId))[0]!
    await pool.query("INSERT INTO assay_finding_reviews (business_id,finding_id,reviewed_by,reviewed_at,decision,review_reason) VALUES ($1,$2,$3,'1999-01-01','REVIEWED_CORRECT','TEST')", [f.businessId, finding.id, f.session.userId])
    expect((await pool.query("SELECT reviewed_at > now()-interval '1 hour' AS fresh FROM assay_finding_reviews WHERE finding_id=$1", [finding.id])).rows[0].fresh).toBe(true)
  })
  it("provenance: proposals need a fetched source and span; fetched sources need evidence and text together", async () => {
    const f = await fixture()
    const normalized = JSON.stringify({ amountMinor: 100, currency: "USD", billingPeriod: "MONTH", unit: "ACCOUNT", qualifier: "EXACT" })
    await expect(pool.query("INSERT INTO assay_proposed_facts (business_id,source_url,fact_type,subject,normalized,supporting_span) VALUES ($1,'https://x.test','PRICE','Northstar',$2::jsonb,'span')", [f.businessId, normalized])).rejects.toThrow()
    await expect(pool.query("INSERT INTO assay_proposed_facts (business_id,source_id,source_url,fact_type,subject,normalized) VALUES ($1,$2,'https://x.test','PRICE','Northstar',$3::jsonb)", [f.businessId, f.source.id, normalized])).rejects.toThrow()
    const queued = await repo(r => r.registerSource({ businessId: f.businessId, url: "https://assay.test/queued-only", subject: "Northstar", planTerms: [], capabilityTerms: [], requestedBy: f.session.userId }))
    await expect(pool.query("INSERT INTO assay_proposed_facts (business_id,source_id,source_url,fact_type,subject,normalized,supporting_span) VALUES ($1,$2,'https://x.test','PRICE','Northstar',$3::jsonb,'span')", [f.businessId, queued.id, normalized])).rejects.toThrow(/fetched source/)
    await expect(pool.query("INSERT INTO assay_sources (business_id,url,subject,requested_by,status,fetched_at) VALUES ($1,'https://assay.test/no-evidence','Northstar',$2,'FETCHED',now())", [f.businessId, f.session.userId])).rejects.toThrow()
    const evidence = (await pool.query("SELECT raw_evidence_id FROM assay_sources WHERE id=$1", [f.source.id])).rows[0].raw_evidence_id as string
    await expect(pool.query("INSERT INTO assay_sources (business_id,url,subject,requested_by,raw_evidence_id) VALUES ($1,'https://assay.test/half','Northstar',$2,$3)", [f.businessId, f.session.userId, evidence])).rejects.toThrow()
  })
  it("dedupes normalized source URLs and duplicate facts into one queue entry and one finding", async () => {
    const f = await fixture()
    const again = await repo(r => r.registerSource({ businessId: f.businessId, url: `HTTPS://ASSAY.TEST/${f.businessId}/pricing#plans`, subject: "Northstar", planTerms: [], capabilityTerms: [], requestedBy: f.session.userId }))
    expect(again.id).toBe(f.source.id)
    const dup = await addSource(f, "/dup")
    const prices = (await repo(r => r.facts(f.businessId)) as readonly AssayFactRow[]).filter(p => p.fact_type === "PRICE")
    expect(prices).toHaveLength(1)
    expect(prices[0]!.source_links.map(l => (l as { sourceId: string }).sourceId).sort()).toEqual([f.source.id, dup.id].sort())
    const hidden = (await pool.query("SELECT id FROM assay_proposed_facts WHERE source_id=$1 AND fact_type='PRICE'", [dup.id])).rows[0].id as string
    expect(await reviewFact(f.session, f.businessId, f.price.id)).toBe(true)
    expect(await reviewFact(f.session, f.businessId, hidden)).toBe(true)
    const group = await sample(f)
    const rows = (await pool.query("SELECT proposed_fact_id FROM assay_findings WHERE sample_group_id=$1", [group.id])).rows
    expect(rows).toEqual([{ proposed_fact_id: f.price.id }])
    expect(await findings(f.businessId)).toHaveLength(1)
  })
  it("partial samples are recorded, never silent success; the successful denominator is used", async () => {
    const f = await fixture("partial Northstar price")
    await reviewFact(f.session, f.businessId, f.price.id)
    await sample(f)
    const groups = await repo(r => r.groups(f.businessId)) as readonly AssayGroupRow[]
    expect(groups[0]).toMatchObject({ status: "PARTIALLY_SUCCEEDED", missing_samples: [{ sampleNumber: 5, failureClass: "PROVIDER_UNAVAILABLE" }] })
    expect((await findings(f.businessId))[0]).toMatchObject({ sample_count: 4, requested_n: 5, contradict_count: 4, verdict: "CONFIRMED" })
  })
  it("all failed samples yield FAILED with no finding", async () => {
    const f = await fixture("allfailed Northstar price")
    await reviewFact(f.session, f.businessId, f.price.id); await sample(f)
    const groups = await repo(r => r.groups(f.businessId)) as readonly AssayGroupRow[]
    expect(groups[0]!.status).toBe("FAILED"); expect(groups[0]!.missing_samples).toHaveLength(5)
    expect(await findings(f.businessId)).toEqual([])
  })
  it("annual/monthly mismatch is UNCLEAR and never a finding", async () => {
    const f = await fixture("annual Northstar price")
    await reviewFact(f.session, f.businessId, f.price.id); await sample(f)
    expect(await findings(f.businessId)).toEqual([])
    expect(await comparisons(f.price.id)).toEqual(Array(5).fill("UNCLEAR"))
  })
  it("2/5 stays intermittent and unclear samples are counted separately", async () => {
    const f = await fixture("intermittent Northstar price")
    await reviewFact(f.session, f.businessId, f.price.id); await sample(f)
    expect((await findings(f.businessId))[0]).toMatchObject({ verdict: "OBSERVED_INTERMITTENT", contradict_count: 2 })
    const u = await fixture("unclear Northstar price")
    await reviewFact(u.session, u.businessId, u.price.id); await sample(u)
    expect((await findings(u.businessId))[0]).toMatchObject({ contradict_count: 4, unclear_count: 1 })
  })
  it("sample integrity: group samples cannot be deleted, re-opened, or marked successful without an observation", async () => {
    const f = await fixture("partial Northstar price")
    const group = await sample(f)
    const failed = (await pool.query("SELECT id FROM check_runs WHERE assay_sample_group_id=$1 AND status='FAILED'", [group.id])).rows[0].id as string
    const succeeded = (await pool.query("SELECT id FROM check_runs WHERE assay_sample_group_id=$1 AND status='SUCCEEDED' LIMIT 1", [group.id])).rows[0].id as string
    await expect(pool.query("UPDATE check_runs SET status='SUCCEEDED',failure_class=NULL WHERE id=$1", [failed])).rejects.toThrow()
    await expect(pool.query("UPDATE check_runs SET status='FAILED' WHERE id=$1", [succeeded])).rejects.toThrow()
    await expect(pool.query("DELETE FROM check_runs WHERE id=$1", [succeeded])).rejects.toThrow()
    // Immutable assay evidence intentionally blocks deleting its business.
    await expect(pool.query("DELETE FROM businesses WHERE id=$1", [f.businessId])).rejects.toThrow()
  })
  it("review membership, reason, content and completed review fields are enforced", async () => {
    const f = await fixture()
    expect(await reviewFact({ ...f.session, userId: "agent-placeholder" }, f.businessId, f.price.id)).toBe(false)
    for (const reason of [null, "", " ", "\t\n"]) {
      await expect(pool.query("UPDATE assay_proposed_facts SET status='CONFIRMED',reviewed_by=$2,reviewed_at=now(),review_reason=$3 WHERE id=$1", [f.price.id, f.session.userId, reason])).rejects.toThrow()
    }
    expect(await reviewFact(f.session, f.businessId, f.price.id)).toBe(true)
    expect(await reviewFact(f.session, f.businessId, f.price.id)).toBe(false)
    for (const sql of ["UPDATE assay_proposed_facts SET reviewed_by='agent' WHERE id=$1", "UPDATE assay_proposed_facts SET review_reason='changed' WHERE id=$1", "UPDATE assay_proposed_facts SET normalized='{}' WHERE id=$1", "DELETE FROM assay_proposed_facts WHERE id=$1"]) await expect(pool.query(sql, [f.price.id])).rejects.toThrow()
    await expect(pool.query("UPDATE assay_sources SET fetched_text='edited' WHERE id=$1", [f.source.id])).rejects.toThrow()
  })
  it("sampling is atomic and bounded, and rejects foreign questions", async () => {
    const f = await fixture(); const other = await fixture()
    for (const n of [0, 21, 2.5]) await expect(enqueue(f, { retrievalMode: "NONE", n })).rejects.toThrow()
    await expect(repo(r => r.enqueueGroup({ businessId: f.businessId, questionId: other.questionId, provider: "mock", requestedModel: null, retrievalMode: "NONE" }))).rejects.toThrow()
    expect((await pool.query("SELECT count(*)::int n FROM assay_sample_groups WHERE business_id=$1", [f.businessId])).rows[0].n).toBe(0)
  })
  it("database rejects cross-business INSERT/UPDATE links and forged spans", async () => {
    const f = await fixture(); const other = await fixture()
    await reviewFact(f.session, f.businessId, f.price.id); await reviewFact(other.session, other.businessId, other.price.id)
    const group = await sample(f)
    const finding = (await findings(f.businessId))[0]!
    const obs = (await pool.query("SELECT o.id FROM observations o JOIN check_runs r ON r.id=o.check_run_id WHERE r.assay_sample_group_id=$1 LIMIT 1", [group.id])).rows[0].id as string
    await expect(pool.query("INSERT INTO assay_sample_judgments (business_id,observation_id,proposed_fact_id,comparison,supporting_span,extractor_kind,extractor_version,structured_output) VALUES ($1,$2,$3,'CONTRADICTS','Northstar','DETERMINISTIC','TEST','{}')", [f.businessId, obs, other.price.id])).rejects.toThrow()
    await expect(pool.query("INSERT INTO assay_sample_judgments (business_id,observation_id,proposed_fact_id,comparison,supporting_span,extractor_kind,extractor_version,structured_output) VALUES ($1,$2,$3,'CONTRADICTS','fabricated','DETERMINISTIC','TEST','{}')", [f.businessId, obs, f.price.id])).rejects.toThrow()
    await expect(pool.query("INSERT INTO assay_findings (business_id,sample_group_id,proposed_fact_id,sample_count,contradict_count,verdict) VALUES ($1,$2,$3,5,4,'CONFIRMED')", [other.businessId, group.id, other.price.id])).rejects.toThrow()
    await expect(pool.query("INSERT INTO assay_finding_reviews (business_id,finding_id,reviewed_by,decision,review_reason) VALUES ($1,$2,$3,'REVIEWED_CORRECT','TEST')", [other.businessId, finding.id, other.session.userId])).rejects.toThrow()
    await expect(pool.query("UPDATE assay_sample_groups SET business_id=$2,question_id=$3 WHERE id=$1", [group.id, other.businessId, other.questionId])).rejects.toThrow()
    await expect(pool.query("UPDATE check_runs SET business_id=$2,question_id=$3 WHERE assay_sample_group_id=$1", [group.id, other.businessId, other.questionId])).rejects.toThrow()
    await expect(pool.query("UPDATE assay_sample_judgments SET proposed_fact_id=$2 WHERE observation_id=$1", [obs, other.price.id])).rejects.toThrow()
    await expect(pool.query("UPDATE assay_findings SET sample_group_id=$2 WHERE id=$1", [finding.id, randomUUID()])).rejects.toThrow()
    expect(await reviewFinding(other.session, f.businessId, finding.id)).toBe(false)
  })
  it("recovers an expired source claim and rejects a stale owner and altered digest", async () => {
    const f = await fixture()
    const source = await repo(r => r.registerSource({ businessId: f.businessId, url: "https://assay.test/recovery", subject: "Northstar", planTerms: [], capabilityTerms: [], requestedBy: f.session.userId }))
    const first = (await repo(r => r.claimSource({ businessId: f.businessId })))!
    expect(first.id).toBe(source.id)
    await pool.query("UPDATE assay_sources SET claimed_at=now()-interval '6 minutes' WHERE id=$1", [source.id])
    const second = (await repo(r => r.claimSource({ businessId: f.businessId })))!
    expect(second.id).toBe(first.id)
    expect(second.claim_token).not.toBe(first.claim_token)
    const evidence = await safeFetch(source.url, { transport })
    const extraction = proposeAssayFacts(html, { subject: "Northstar", planTerms: [], capabilityTerms: [] })
    await repo(r => r.completeSource(first, evidence, extraction.text, extraction.facts))
    expect((await pool.query("SELECT status FROM assay_sources WHERE id=$1", [source.id])).rows[0].status).toBe("FETCHING")
    await expect(repo(r => r.completeSource(second, { ...evidence, bodyDigest: "0".repeat(64) }, extraction.text, extraction.facts))).rejects.toThrow(/digest mismatch/)
    await repo(r => r.completeSource(second, evidence, extraction.text, extraction.facts))
    expect((await pool.query("SELECT status FROM assay_sources WHERE id=$1", [source.id])).rows[0].status).toBe("FETCHED")
    expect((await pool.query("SELECT count(*)::int n FROM assay_proposed_facts WHERE source_id=$1", [source.id])).rows[0].n).toBe(1)
  })
  it("safeFetch rejects private sources before injected transport fetching", async () => {
    const f = await fixture()
    const source = await repo(r => r.registerSource({ businessId: f.businessId, url: "http://127.0.0.1/private", subject: "Northstar", planTerms: [], capabilityTerms: [], requestedBy: f.session.userId }))
    expect(await finishSource(f.businessId, source.id)).toBe("FAILED")
    expect(fetchedUrls.some(url => url.includes("127.0.0.1"))).toBe(false)
    expect((await pool.query("SELECT status,failure_class FROM assay_sources WHERE id=$1", [source.id])).rows[0]).toEqual({ status: "FAILED", failure_class: "SECURITY_REJECTED" })
  })
})
