// PostgreSQL 16 integration tests for Product Surface V1 reads:
// acceptance fixtures A (hosted Acme), B (repository Northstar), C (unknown),
// D (untracked citation), tenancy, and the repository-mutation backstop.
// Requires DATABASE_URL (CI provides a postgres service; skipped otherwise).
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { buildGraph } from "@ghostping/representation"
import { migrate } from "./migrate.js"
import { FactRepository, FactRepositoryLive } from "./repositories.js"
import { ProductReadRepository, ProductReadRepositoryLive } from "./product.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const run = url ? describe : describe.skip
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

type Repos = FactRepository | ProductReadRepository

run("postgres product surface v1", () => {
  let pool: pg.Pool
  let scope: Scope.CloseableScope
  let ctx: Context.Context<Repos>
  const runFx = <A, E>(fx: Effect.Effect<A, E, Repos>) => Effect.runPromise(Effect.provide(fx, ctx))
  const runExit = <A, E>(fx: Effect.Effect<A, E, Repos>) => Effect.runPromiseExit(Effect.provide(fx, ctx))
  const repo = <I, S>(tag: Context.Tag<I, S>) => Context.get(ctx as Context.Context<I>, tag)

  beforeAll(async () => {
    await migrate(url)
    pool = new pg.Pool({ connectionString: url })
    scope = await Effect.runPromise(Scope.make())
    const live = Layer.provide(
      Layer.mergeAll(FactRepositoryLive, ProductReadRepositoryLive),
      PgClient.layer({ url: Redacted.make(url) }),
    )
    ctx = await Effect.runPromise(Layer.buildWithScope(live, scope))
  })
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await pool.end()
  })

  const setupAcme = async () => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Acme') RETURNING id`, [accountId])).rows[0]["id"] as string
    // Truth v2: 49 USD ACTIVE with SUPERSEDED v1 history.
    const v1 = (await pool.query(
      `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, valid_from, source_kind) VALUES ($1,'Acme Starter','monthly price','39 USD','CURRENCY','SUPERSEDED',1,'2026-01-01T00:00:00Z','MANUAL') RETURNING id`,
      [businessId],
    )).rows[0]["id"] as string
    const v2 = (await pool.query(
      `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, supersedes_id, valid_from, source_kind) VALUES ($1,'Acme Starter','monthly price','49 USD','CURRENCY','ACTIVE',2,$2,'2026-06-01T00:00:00Z','MANUAL') RETURNING id`,
      [businessId, v1],
    )).rows[0]["id"] as string
    const pricing = (await pool.query(`INSERT INTO source_targets (business_id, url, control) VALUES ($1,'https://acme.example/pricing','OWNED') RETURNING id`, [businessId])).rows[0]["id"] as string
    const docs = (await pool.query(`INSERT INTO source_targets (business_id, url, control) VALUES ($1,'https://docs.acme.example/billing','OWNED') RETURNING id`, [businessId])).rows[0]["id"] as string
    const bindPricing = (await pool.query(
      `INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator) VALUES ($1,$2,$3,'JSON_LD','offers.price','MONEY') RETURNING id`,
      [businessId, v2, pricing],
    )).rows[0]["id"] as string
    const bindDocs = (await pool.query(
      `INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator) VALUES ($1,$2,$3,'CSS_TEXT','[data-plan="starter"] .price','MONEY') RETURNING id`,
      [businessId, v2, docs],
    )).rows[0]["id"] as string
    // Pricing: good 10:00 observation, then failed 11:00 timeout.
    const obs10 = (await pool.query(
      `INSERT INTO source_observations (business_id, source_target_id, requested_url, final_url, started_at, completed_at, http_status, content_type, etag, body_digest, body_bytes, collection_state) VALUES ($1,$2,'https://acme.example/pricing','https://acme.example/pricing','2026-10-03T10:00:00Z','2026-10-03T10:00:00Z',200,'text/html','"e1"','aa',128,'FETCHED') RETURNING id`,
      [businessId, pricing],
    )).rows[0]["id"] as string
    const obs11 = (await pool.query(
      `INSERT INTO source_observations (business_id, source_target_id, requested_url, final_url, started_at, completed_at, collection_state, failure) VALUES ($1,$2,'https://acme.example/pricing','https://acme.example/pricing','2026-10-03T11:00:00Z','2026-10-03T11:00:00Z','FAILED','TIMEOUT') RETURNING id`,
      [businessId, pricing],
    )).rows[0]["id"] as string
    await pool.query(
      `INSERT INTO observed_source_values (business_id, source_observation_id, source_binding_id, fact_id, extracted_value, extraction_state, evidence_selector, evidence_observation_id) VALUES ($1,$2,$3,$4,'49 USD','OBSERVED','offers.price',$2)`,
      [businessId, obs10, bindPricing, v2],
    )
    const obsDocs = (await pool.query(
      `INSERT INTO source_observations (business_id, source_target_id, requested_url, final_url, started_at, completed_at, http_status, content_type, body_digest, body_bytes, collection_state) VALUES ($1,$2,'https://docs.acme.example/billing','https://docs.acme.example/billing','2026-10-03T09:00:00Z','2026-10-03T09:00:00Z',200,'text/html','bb',96,'FETCHED') RETURNING id`,
      [businessId, docs],
    )).rows[0]["id"] as string
    await pool.query(
      `INSERT INTO observed_source_values (business_id, source_observation_id, source_binding_id, fact_id, extracted_value, extraction_state, evidence_selector, evidence_observation_id) VALUES ($1,$2,$3,$4,'39 USD','OBSERVED','[data-plan="starter"] .price',$2)`,
      [businessId, obsDocs, bindDocs, v2],
    )
    // AI side: Gemini says $39/month, cites docs, judged CONTRADICTED.
    const qid = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'How much does Acme Starter cost?') RETURNING id`, [businessId])).rows[0]["id"] as string
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, provider, status) VALUES ($1,$2,'mock','SUCCEEDED') RETURNING id`, [businessId, qid])).rows[0]["id"] as string
    const digest = createHash("sha256").update(unique("raw")).digest("hex")
    const rawId = (await pool.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{"answer":"$39/month"}') RETURNING id`, [digest])).rows[0]["id"] as string
    const obsId = (await pool.query(
      `INSERT INTO observations (business_id, check_run_id, provider, collected_at, answer_text, raw_evidence_id, raw_digest) VALUES ($1,$2,'mock','2026-10-03T12:00:00Z','$39/month',$3,$4) RETURNING id`,
      [businessId, runId, rawId, digest],
    )).rows[0]["id"] as string
    await pool.query(`INSERT INTO observation_citations (observation_id, uri, title, position, attributed) VALUES ($1,'https://docs.acme.example/billing','Billing docs',1,true)`, [obsId])
    // Fixture D: an untracked third-party citation lives alongside, unmatched.
    await pool.query(`INSERT INTO observation_citations (observation_id, uri, title, position, attributed) VALUES ($1,'https://thirdparty.example/acme','Third-party review',2,false)`, [obsId])
    const claimId = (await pool.query(`INSERT INTO candidate_claims (business_id, observation_id, text, origin) VALUES ($1,$2,'$39/month','MANUAL_EXACT_SPAN') RETURNING id`, [businessId, obsId])).rows[0]["id"] as string
    const judgmentId = (await pool.query(`INSERT INTO human_judgments (business_id, claim_id, verdict) VALUES ($1,$2,'CONTRADICTED') RETURNING id`, [businessId, claimId])).rows[0]["id"] as string
    await pool.query(`INSERT INTO human_judgment_facts (judgment_id, fact_id) VALUES ($1,$2)`, [judgmentId, v2])
    return { accountId, businessId, v1, v2, pricing, docs, bindPricing, bindDocs, obs10, obs11, obsId, claimId }
  }

  it("fixture A: IN_SYNC survives a later failed attempt; docs DRIFT; citation matches", async () => {
    const biz = await setupAcme()
    const reads = repo(ProductReadRepository)
    const [targets, bindings, observations, values, citations] = await runFx(
      Effect.all([reads.targets(biz.businessId), reads.bindings(biz.businessId), reads.observations(biz.businessId), reads.values(biz.businessId), reads.aiCitations(biz.businessId)]),
    )
    expect(targets.map((t) => t.url).sort()).toEqual(["https://acme.example/pricing", "https://docs.acme.example/billing"])
    expect(bindings).toHaveLength(2)
    const graph = buildGraph({
      fact: { id: biz.v2, value_text: "49 USD", value_type: "CURRENCY" },
      targets: targets.map((t) => ({ id: t.id, business_id: biz.businessId, url: t.url, control: t.control as "OWNED", enabled: true, created_at: t.createdAt })),
      bindings: bindings.map((b) => ({
        id: b.id, business_id: biz.businessId, fact_id: b.factId, source_target_id: b.sourceTargetId,
        extractor: { kind: b.extractorKind as "JSON_LD", selector: b.extractorSelector },
        comparator: b.comparator as "MONEY", created_at: "",
      })),
      observations: observations.map((o) => ({
        id: o.id, business_id: biz.businessId, source_target_id: o.sourceTargetId, collector: "NATIVE_HTTP" as const, collector_version: o.collectorVersion,
        requested_url: "", final_url: "", started_at: "", completed_at: o.completedAt, http_status: o.httpStatus, content_type: o.contentType,
        etag: o.etag, last_modified: o.lastModified, body_digest: o.bodyDigest, body_bytes: o.bodyBytes,
        collection_state: o.collectionState as "FETCHED" | "NOT_MODIFIED" | "FAILED", failure: o.failure as "TIMEOUT" | null, raw_evidence_id: null,
      })),
      values: values.map((v) => ({
        id: v.id, business_id: biz.businessId, source_observation_id: v.sourceObservationId, source_binding_id: v.sourceBindingId, fact_id: v.factId,
        extracted_value: v.extractedValue, extraction_state: v.extractionState as "OBSERVED",
        evidence_locator: { selector: v.evidenceSelector, source_observation_id: v.evidenceObservationId, node_identity: v.evidenceNodeIdentity },
        extractor_version: v.extractorVersion, created_at: v.createdAt,
      })),
      aiCitations: [],
    })
    const byBinding = new Map(graph.findings.map((f) => [f.source_binding_id, f]))
    expect(byBinding.get(biz.bindPricing)).toMatchObject({ state: "IN_SYNC", source_observation_id: biz.obs10 })
    expect(byBinding.get(biz.bindDocs)).toMatchObject({ state: "DRIFT" })
    // Latest attempt (failed 11:00) preserved alongside effective evidence.
    const attempts = observations.filter((o) => o.sourceTargetId === biz.pricing).sort((a, b) => a.completedAt.localeCompare(b.completedAt))
    expect(attempts.map((o) => o.collectionState)).toEqual(["FETCHED", "FAILED"])
    // Citation stored exactly as returned, matched to the docs target.
    expect(citations.map((c) => String(c["uri"]))).toContain("https://docs.acme.example/billing")
    // Fixture D: untracked citation returned verbatim with no target match.
    expect(citations.map((c) => String(c["uri"]))).toContain("https://thirdparty.example/acme")
    expect(targets.some((t) => t.url === "https://thirdparty.example/acme")).toBe(false)
    expect(JSON.stringify(graph)).not.toMatch(/CAUSED_BY/i)
  })

  it("fixture B: repository mode, provenance, and mutation backstop", async () => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Northstar') RETURNING id`, [accountId])).rows[0]["id"] as string
    await pool.query(`INSERT INTO business_authority_mode (business_id, writer) VALUES ($1,'REPOSITORY_MANIFEST')`, [businessId])
    const syncClient = await pool.connect()
    try {
      await syncClient.query("BEGIN")
      await syncClient.query("SET LOCAL ghostping.authority_sync = '1'")
      let prev: string | null = null
      for (const version of [1, 2, 3]) {
        const row = (await syncClient.query(
          `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, supersedes_id, valid_from, source_kind) VALUES ($1,'plan:starter','price','59 USD','CURRENCY',${version === 3 ? "'ACTIVE'" : "'SUPERSEDED'"},${version},${prev === null ? "NULL" : "$2"},'2026-01-01T00:00:00Z','MANUAL') RETURNING id`,
          prev === null ? [businessId] : [businessId, prev],
        )).rows[0]["id"] as string
        await syncClient.query(
          `INSERT INTO repository_fact_provenance (fact_id, business_id, manifest_key, manifest_digest, source_revision, synced_at, source_url) VALUES ($1,$2,'starter-price','${"d".repeat(64)}','rev-9','2026-10-03T00:00:00.000Z','https://northstar.example/pricing')`,
          [row, businessId],
        )
        prev = row
      }
      await syncClient.query("COMMIT")
    } finally {
      syncClient.release()
    }
    const reads = repo(ProductReadRepository)
    expect(await runFx(reads.authorityMode(businessId))).toBe("REPOSITORY_MANIFEST")
    const prov = await runFx(reads.factProvenance(businessId))
    const active = prov.filter((p) => p.manifestKey === "starter-price")
    expect(active.length).toBe(3)
    const latest = active.find((p) => p.sourceRevision === "rev-9")
    expect(latest).toMatchObject({ manifestKey: "starter-price", sourceRevision: "rev-9", sourceUrl: "https://northstar.example/pricing" })
    const facts = repo(FactRepository)
    const exit = await runExit(facts.create({ businessId, subject: "x", predicate: "y", valueText: "z", valueType: "TEXT", validFrom: "2026-10-03T00:00:00.000Z", validUntil: null, sourceKind: "MANUAL" }))
    expect(exit._tag).toBe("Failure")
  })

  it("fixture C: untracked source with no observation is UNKNOWN, not drift", async () => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'AcmeC') RETURNING id`, [accountId])).rows[0]["id"] as string
    const fid = (await pool.query(`INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, valid_from, source_kind) VALUES ($1,'product','integration.salesforce','false','BOOLEAN','ACTIVE',1,'2026-01-01T00:00:00Z','MANUAL') RETURNING id`, [businessId])).rows[0]["id"] as string
    const target = (await pool.query(`INSERT INTO source_targets (business_id, url, control) VALUES ($1,'https://acme.example/integrations','OWNED') RETURNING id`, [businessId])).rows[0]["id"] as string
    const binding = (await pool.query(`INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator) VALUES ($1,$2,$3,'CSS_TEXT','.inte','BOOLEAN') RETURNING id`, [businessId, fid, target])).rows[0]["id"] as string
    const graph = buildGraph({
      fact: { id: fid, value_text: "false", value_type: "BOOLEAN" },
      targets: [{ id: target, business_id: businessId, url: "https://acme.example/integrations", control: "OWNED", enabled: true, created_at: "2026-10-03T00:00:00.000Z" }],
      bindings: [{ id: binding, business_id: businessId, fact_id: fid, source_target_id: target, extractor: { kind: "CSS_TEXT", selector: ".inte" }, comparator: "BOOLEAN", created_at: "" }],
      observations: [],
      values: [],
      aiCitations: [],
    })
    expect(graph.findings).toHaveLength(1)
    expect(graph.findings[0]?.state).toBe("UNKNOWN")
  })

  it("observation citations never multiply across claims", async () => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'CiteDedupe') RETURNING id`, [accountId])).rows[0]["id"] as string
    const questionId = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'Dedupe?') RETURNING id`, [businessId])).rows[0]["id"] as string
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'SUCCEEDED') RETURNING id`, [businessId, questionId])).rows[0]["id"] as string
    const digest = createHash("sha256").update(unique("raw")).digest("hex")
    const rawId = (await pool.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') RETURNING id`, [digest])).rows[0]["id"] as string
    const obsId = (await pool.query(`INSERT INTO observations (business_id, check_run_id, provider, collected_at, answer_text, raw_evidence_id, raw_digest) VALUES ($1,$2,'mock','2026-10-03T12:00:00Z','hi',$3,$4) RETURNING id`, [businessId, runId, rawId, digest])).rows[0]["id"] as string
    await pool.query(`INSERT INTO observation_citations (observation_id, uri) VALUES ($1,'https://example.com/only')`, [obsId])
    for (const text of ["Claim A", "Claim B", "Claim C"]) {
      await pool.query(`INSERT INTO candidate_claims (business_id, observation_id, text, origin) VALUES ($1,$2,$3,'MANUAL_EXACT_SPAN')`, [businessId, obsId, text])
    }
    const reads = repo(ProductReadRepository)
    // One citation row + three claims yields exactly one citation result.
    const citations = await runFx(reads.aiCitations(businessId))
    expect(citations).toHaveLength(1)
    expect(citations[0]).toMatchObject({ uri: "https://example.com/only" })
    expect("claim_id" in (citations[0] as Record<string, unknown>)).toBe(false)
    expect("claim_text" in (citations[0] as Record<string, unknown>)).toBe(false)
  })
  it("fact lineage follows supersedes_id across metadata changes", async () => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Lineage') RETURNING id`, [accountId])).rows[0]["id"] as string
    const reads = repo(ProductReadRepository)
    const insert = async (subject: string, predicate: string, value: string, version: number, sup: string | null): Promise<string> =>
      String(
        (
          (await pool.query(
            `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, supersedes_id, valid_from, source_kind) VALUES ($1,$2,$3,$4,'CURRENCY','ACTIVE',$5,$6,'2026-01-01T00:00:00Z','MANUAL') RETURNING id`,
            [businessId, subject, predicate, value, version, sup],
          )).rows[0] as Record<string, unknown>
        )["id"],
      )
    // v1 -> v2 value change; v2 -> v3 subject+predicate+source change.
    const v1 = await insert("plan:starter", "price", "49 USD", 1, null)
    const v2 = await insert("plan:starter", "price", "59 USD", 2, v1)
    const v3 = await insert("plan:starter-v2", "monthly_price", "59 USD", 3, v2)
    const fromOld = await runFx(reads.factLineage(businessId, v1))
    const fromCurrent = await runFx(reads.factLineage(businessId, v3))
    expect(fromOld.map((r) => String(r["id"]))).toEqual([v1, v2, v3])
    expect(fromCurrent.map((r) => String(r["id"]))).toEqual([v1, v2, v3])
    expect(fromCurrent.map((r) => Number(r["version"]))).toEqual([1, 2, 3])
    // Retire v3, reactivate as v4: lineage stays complete.
    await pool.query(`UPDATE authoritative_facts SET status = 'RETIRED' WHERE id = $1`, [v3])
    const v4 = await insert("plan:starter-v2", "monthly_price", "69 USD", 4, v3)
    expect((await runFx(reads.factLineage(businessId, v4))).map((r) => String(r["id"]))).toEqual([v1, v2, v3, v4])
    // Linear lineage returns identically from every version.
    for (const start of [v1, v2, v3, v4]) {
      expect((await runFx(reads.factLineage(businessId, start))).map((r) => String(r["id"])), `from ${start}`).toEqual([v1, v2, v3, v4])
    }
    // Malformed fork: EVERY starting version sees the full component.
    //         v2 → v3 → v4
    //        /
    //   v1 --+
    //        \
    //         fork
    const fork = await insert("plan:fork", "price", "0 USD", 9, v1)
    const whole = [v1, v2, v3, v4, fork]
    for (const start of whole) {
      const seen = await runFx(reads.factLineage(businessId, start))
      expect(seen.map((r) => String(r["id"])).sort(), `from ${start}`).toEqual([...whole].sort())
    }
    const branched = await runFx(reads.factLineage(businessId, v1))
    const childrenOfV1 = branched.filter((r) => (r["supersedes_id"] as string | null) === v1)
    expect(childrenOfV1.length).toBe(2)
    expect(branched.map((r) => Number(r["version"])).sort()).toEqual([1, 2, 3, 4, 9])
  })

  it("tenancy: cross-business representation and truth reads stay invisible", async () => {
    const biz = await setupAcme()
    const other = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const otherBiz = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Other') RETURNING id`, [other])).rows[0]["id"] as string
    const reads = repo(ProductReadRepository)
    expect(await runFx(reads.binding(otherBiz, biz.bindPricing))).toBeNull()
    expect(await runFx(reads.targets(otherBiz))).toEqual([])
    expect(await runFx(reads.bindings(otherBiz))).toEqual([])
    expect(await runFx(reads.observations(otherBiz))).toEqual([])
    expect(await runFx(reads.values(otherBiz))).toEqual([])
    expect(await runFx(reads.aiCitations(otherBiz))).toEqual([])
    expect(await runFx(reads.authorityMode(otherBiz))).toBeNull()
    expect(await runFx(reads.factProvenance(otherBiz))).toEqual([])
  })
})
