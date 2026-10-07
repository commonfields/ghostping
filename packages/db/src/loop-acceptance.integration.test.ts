// Full Northstar loop through service boundaries (no hand-mutated core
// steps): approved truth → tracked source before → action + explicit link →
// verify-source collect → value comparison → recheck intent/run/link.
// Requires DATABASE_URL (skipped otherwise). Stub HTTP transport: no network.
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import pg from "pg"
import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "@effect/sql"
import type { FetchResponse, HttpTransport } from "@openrecord/representation"
import { compareMoney } from "@openrecord/representation"
import { ObservationRepository, ObservationRepositoryLive } from "./repositories.js"
import {
  InterventionBindingRepository,
  InterventionBindingRepositoryLive,
  InterventionRepository,
  InterventionRepositoryLive,
  ReobservationIntentRepository,
  ReobservationIntentRepositoryLive,
  finalizeReobservationLinkForCheckRun,
  hostedMeasurementContext,
} from "./evidence.js"
import { collectSourceBinding } from "./representation-collect.js"
import { migrate } from "./migrate.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const run = url ? describe : describe.skip
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

const PRICE_HTML = (price: string): string =>
  `<!doctype html><html><head><title>Pricing</title></head><body><span class="price">${price}</span></body></html>`

const stubTransport = (body: string): HttpTransport => ({
  lookup: async () => ["93.184.216.34"],
  fetch: async (): Promise<FetchResponse> => ({
    status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode(body), peerIp: "93.184.216.34",
  }),
})

type Ctx = ObservationRepository | InterventionRepository | InterventionBindingRepository | ReobservationIntentRepository | PgClient.PgClient

run("postgres full Northstar loop", () => {
  let pool: pg.Pool
  let scope: Scope.CloseableScope
  let ctx: Context.Context<Ctx>
  const runFx = <A, E>(fx: Effect.Effect<A, E, Ctx>) => Effect.runPromise(Effect.provide(fx, ctx))

  beforeAll(async () => {
    await migrate(url)
    pool = new pg.Pool({ connectionString: url })
    scope = await Effect.runPromise(Scope.make())
    const live = Layer.provide(
      Layer.mergeAll(ObservationRepositoryLive, InterventionRepositoryLive, InterventionBindingRepositoryLive, ReobservationIntentRepositoryLive),
      PgClient.layer({ url: Redacted.make(url) }),
    )
    const pgLive = Layer.mergeAll(live, PgClient.layer({ url: Redacted.make(url) }))
    ctx = await Effect.runPromise(Layer.buildWithScope(pgLive, scope))
  })

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await pool.end()
  })

  it("KNOW→OBSERVE→DIAGNOSE→ACT→VERIFY→RECHECK→LINK with no core-step DB edits", async () => {
    // KNOW: approved $59.
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Northstar') RETURNING id`, [accountId])).rows[0]["id"] as string
    const factId = (await pool.query(
      `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from) VALUES ($1,'Northstar','monthly_price','59 USD','CURRENCY','2026-01-01T00:00:00Z') RETURNING id`,
      [businessId],
    )).rows[0]["id"] as string
    const targetId = (await pool.query(`INSERT INTO source_targets (business_id, url, control) VALUES ($1,'http://example.test/pricing','OWNED') RETURNING id`, [businessId])).rows[0]["id"] as string
    const bindingId = (await pool.query(
      `INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator) VALUES ($1,$2,$3,'CSS_TEXT','.price','MONEY') RETURNING id`,
      [businessId, factId, targetId],
    )).rows[0]["id"] as string

    // OBSERVE AI ($49) + DIAGNOSE (claim; WRONG verdict shape proven elsewhere).
    const questionId = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'How much?') RETURNING id`, [businessId])).rows[0]["id"] as string
    const aiRunId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, provider, status) VALUES ($1,$2,'mock','SUCCEEDED') RETURNING id`, [businessId, questionId])).rows[0]["id"] as string
    const raw = JSON.stringify({ answer: "Northstar costs $49.", run: aiRunId })
    const context = hostedMeasurementContext({ businessId, questionId, checkRunId: aiRunId, prompt: "How much?", provider: "mock", requestedModel: null, observedModel: null, observedAt: "2026-10-01T00:00:00.000Z" })
    const aiObs = await runFx(Effect.flatMap(ObservationRepository, (r) => r.create({
      businessId, checkRunId: aiRunId, provider: "mock", requestedModel: null, observedModel: null,
      collectedAt: "2026-10-01T00:00:00.000Z", answerText: "Northstar costs $49.", retrievalMode: "unknown",
      rawResponse: JSON.parse(raw), rawDigest: sha(raw), rawBytesHex: Buffer.from(raw).toString("hex"),
      rawContentType: "application/json", providerMetadata: { synthetic: true },
      surfaceIdentity: context.surface, measurementContext: context, synthetic: true, citations: [],
    })))
    const claimId = (await pool.query(`INSERT INTO candidate_claims (business_id, observation_id, text) VALUES ($1,$2,'Northstar costs $49') RETURNING id`, [businessId, aiObs.id])).rows[0]["id"] as string

    // TRACKED SOURCE BEFORE ($49, DRIFT vs $59) through the real collect path.
    const beforeCollect = await runFx(collectSourceBinding(businessId, bindingId, stubTransport(PRICE_HTML("$49"))))
    expect(beforeCollect).not.toBeNull()
    expect(beforeCollect?.finding.state).toBe("DRIFT")
    const beforeValue = beforeCollect?.values.find((v) => v.extraction_state === "OBSERVED")?.extracted_value ?? null
    expect(beforeValue).toContain("49")

    // ACT: SOURCE_UPDATED linked to the tracked binding (server-side shape).
    const iv = await runFx(Effect.flatMap(InterventionRepository, (r) => r.append({
      businessId, issueIds: [claimId], type: "SOURCE_UPDATED", target: "http://example.test/pricing",
      performedAt: "2026-10-02T00:00:00.000Z", actor: "HUMAN", actorId: USER, notes: null,
      evidenceBeforeDigest: null, evidenceAfterDigest: null, supersedesId: null, correctionReason: null,
    })))
    const linked = await runFx(Effect.flatMap(InterventionBindingRepository, (r) =>
      r.linkInterventionBinding({ businessId, interventionId: iv.id, sourceBindingId: bindingId, beforeSourceObservationId: beforeCollect!.observation.id })))
    expect(linked.sourceBindingId).toBe(bindingId)

    // VERIFY SOURCE: page now shows $59 → value-level CHANGED, alignment IN_SYNC.
    const afterCollect = await runFx(collectSourceBinding(businessId, bindingId, stubTransport(PRICE_HTML("$59"))))
    expect(afterCollect?.finding.state).toBe("IN_SYNC")
    const afterValue = afterCollect?.values.find((v) => v.extraction_state === "OBSERVED")?.extracted_value ?? null
    expect(compareMoney(beforeValue ?? "", afterValue ?? "")).toBe("DRIFT")
    expect(compareMoney("59 USD", afterValue ?? "")).toBe("IN_SYNC")

    // Negative: stale page ($49 again) compares equivalent at value level.
    const staleCollect = await runFx(collectSourceBinding(businessId, bindingId, stubTransport(PRICE_HTML("$49"))))
    expect(compareMoney(beforeValue ?? "", staleCollect?.values.find((v) => v.extraction_state === "OBSERVED")?.extracted_value ?? "")).toBe("IN_SYNC")

    // RECHECK: intent + run + observation, then exactly one durable link.
    const recheckRunId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, provider, status) VALUES ($1,$2,'mock','QUEUED') RETURNING id`, [businessId, questionId])).rows[0]["id"] as string
    const created = await runFx(Effect.flatMap(ReobservationIntentRepository, (r) =>
      r.createIntent({ businessId, issueId: claimId, originalObservationId: aiObs.id, interventionId: iv.id, checkRunId: recheckRunId, createdByUserId: USER })))
    expect(created).not.toBeNull()
    await pool.query(`UPDATE check_runs SET status = 'RUNNING' WHERE id = $1`, [recheckRunId])
    const afterRaw = JSON.stringify({ answer: "Northstar costs $59.", run: recheckRunId })
    const afterContext = hostedMeasurementContext({ businessId, questionId, checkRunId: recheckRunId, prompt: "How much?", provider: "mock", requestedModel: null, observedModel: null, observedAt: "2026-10-03T00:00:00.000Z" })
    await runFx(Effect.flatMap(ObservationRepository, (r) => r.create({
      businessId, checkRunId: recheckRunId, provider: "mock", requestedModel: null, observedModel: null,
      collectedAt: "2026-10-03T00:00:00.000Z", answerText: "Northstar costs $59.", retrievalMode: "unknown",
      rawResponse: JSON.parse(afterRaw), rawDigest: sha(afterRaw), rawBytesHex: Buffer.from(afterRaw).toString("hex"),
      rawContentType: "application/json", providerMetadata: { synthetic: true },
      surfaceIdentity: afterContext.surface, measurementContext: afterContext, synthetic: true, citations: [],
      completeRun: true,
    })))
    const linkedTwice = await runFx(
      Effect.flatMap(PgClient.PgClient, (sql) => finalizeReobservationLinkForCheckRun(sql as SqlClient.SqlClient, recheckRunId)),
    )
    expect(linkedTwice).not.toBeNull()
    expect((await pool.query(`SELECT count(*)::int AS n FROM reobservations WHERE issue_id = $1`, [claimId])).rows[0]["n"]).toBe(1)
  })
})
