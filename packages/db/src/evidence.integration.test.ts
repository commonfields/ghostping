// PostgreSQL 16 integration tests for Evidence Protocol V1 persistence:
// append-only interventions, re-observation lineage, tenant isolation,
// concurrent appends, and deterministic packet export.
// Requires DATABASE_URL (CI provides a postgres service; skipped otherwise).
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import pg from "pg"
import { PgClient } from "@effect/sql-pg"
import { renderEvidencePacket, serializePacket, validatePacket } from "@ghostping/protocol"
import {
  JudgmentRepository,
  JudgmentRepositoryLive,
  ObservationRepository,
  ObservationRepositoryLive,
} from "./repositories.js"
import {
  EvidenceLineageRepository,
  EvidenceLineageRepositoryLive,
  exportIssuePacket,
  hostedMeasurementContext,
  InterventionRepository,
  InterventionRepositoryLive,
  ReobservationRepository,
  ReobservationRepositoryLive,
  type InterventionInput,
} from "./evidence.js"
import { migrate } from "./migrate.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const run = url ? describe : describe.skip
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

type Repos =
  | ObservationRepository
  | JudgmentRepository
  | InterventionRepository
  | ReobservationRepository
  | EvidenceLineageRepository

run("postgres evidence protocol v1", () => {
  let pool: pg.Pool
  let scope: Scope.CloseableScope
  let ctx: Context.Context<Repos>
  const runFx = <A, E>(fx: Effect.Effect<A, E, Repos>) => Effect.runPromise(Effect.provide(fx, ctx))
  const runExit = <A, E>(fx: Effect.Effect<A, E, Repos>) => Effect.runPromiseExit(Effect.provide(fx, ctx))
  const repo = <I, S>(tag: Context.Tag<I, S>) => Context.get(ctx as Context.Context<I>, tag)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    scope = await Effect.runPromise(Scope.make())
    const live = Layer.provide(
      Layer.mergeAll(ObservationRepositoryLive, JudgmentRepositoryLive, InterventionRepositoryLive, ReobservationRepositoryLive, EvidenceLineageRepositoryLive),
      PgClient.layer({ url: Redacted.make(url) }),
    )
    ctx = await Effect.runPromise(Layer.buildWithScope(live, scope))
  })
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await pool.end()
  })

  const QUESTION = "How much does Acme Starter cost?"

  const setupBusiness = async () => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"] as string
    const businessId = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Acme') RETURNING id`, [accountId])).rows[0]["id"] as string
    const questionId = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,$2) RETURNING id`, [businessId, QUESTION])).rows[0]["id"] as string
    const factId = (await pool.query(
      `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from) VALUES ($1,'Acme Starter','monthly price','$39/month','CURRENCY','2026-01-01T00:00:00Z') RETURNING id`,
      [businessId],
    )).rows[0]["id"] as string
    return { accountId, businessId, questionId, factId }
  }

  /** An observation stored through the real worker path (exact bytes + context). */
  const observe = async (biz: { businessId: string; questionId: string }, answer: string, collectedAt: string) => {
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'SUCCEEDED') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
    const raw = { answer, run: runId }
    const bytes = JSON.stringify(raw)
    const context = hostedMeasurementContext({
      businessId: biz.businessId, questionId: biz.questionId, checkRunId: runId, prompt: QUESTION,
      provider: "mock", requestedModel: null, observedModel: null, observedAt: collectedAt,
    })
    const obs = await runFx(Effect.flatMap(ObservationRepository, (r) => r.create({
      businessId: biz.businessId, checkRunId: runId, provider: "mock", requestedModel: null, observedModel: null,
      collectedAt, answerText: answer, retrievalMode: "unknown", rawResponse: raw, rawDigest: sha(bytes),
      rawBytesHex: Buffer.from(bytes).toString("hex"), rawContentType: "application/json", providerMetadata: { synthetic: true },
      surfaceIdentity: context.surface, measurementContext: context, synthetic: true,
      citations: [{ uri: "https://example.com/acme-review", title: "Review", position: 1, attributed: false }],
    })))
    return { observationId: obs.id, bytes }
  }
  const claim = async (businessId: string, observationId: string, text: string) =>
    (await pool.query(`INSERT INTO candidate_claims (business_id, observation_id, text, origin) VALUES ($1,$2,$3,'MANUAL_EXACT_SPAN') RETURNING id`, [businessId, observationId, text])).rows[0]["id"] as string
  const judge = (businessId: string, claimId: string, verdict: string, factIds: Array<string>) =>
    runFx(Effect.flatMap(JudgmentRepository, (r) => r.create({ businessId, claimId, verdict, notes: null, factIds })))
  const intervention = (businessId: string, issueIds: Array<string>, extra: Partial<InterventionInput> = {}): InterventionInput => ({
    businessId, issueIds, type: "SOURCE_UPDATED", target: "https://acme.example/pricing", performedAt: "2026-10-01T12:00:00.000Z",
    actor: "HUMAN", actorId: null, notes: null, evidenceBeforeDigest: "a".repeat(64), evidenceAfterDigest: "b".repeat(64),
    supersedesId: null, correctionReason: null, ...extra,
  })

  /** PART 11 lineage built entirely through repositories. */
  const acceptanceLineage = async () => {
    const biz = await setupBusiness()
    const before = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
    const issueId = await claim(biz.businessId, before.observationId, "$29/month")
    await judge(biz.businessId, issueId, "INSUFFICIENT_EVIDENCE", [])
    await judge(biz.businessId, issueId, "CONTRADICTED", [biz.factId])
    const iv = await runFx(Effect.flatMap(InterventionRepository, (r) => r.append(intervention(biz.businessId, [issueId]))))
    const after = await observe(biz, "$39/month", "2026-10-02T00:00:00.000Z")
    const link = await runFx(Effect.flatMap(ReobservationRepository, (r) => r.append({
      businessId: biz.businessId, originalObservationId: before.observationId, issueId, interventionId: iv.id, observationId: after.observationId,
    })))
    const afterClaim = await claim(biz.businessId, after.observationId, "$39/month")
    await judge(biz.businessId, afterClaim, "SUPPORTED", [biz.factId])
    return { ...biz, before, after, issueId, intervention: iv, link }
  }

  it("migrations re-run cleanly on PostgreSQL 16", async () => {
    const version = (await pool.query(`SHOW server_version_num`)).rows[0]["server_version_num"] as string
    expect(Number(version)).toBeGreaterThanOrEqual(160000)
    await migrate(url)
    await migrate(url)
    const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('interventions','intervention_issues','reobservations')`)
    expect(tables.rows).toHaveLength(3)
    const derived = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name IN ('reobservations','interventions') AND column_name IN ('corrected','outcome','caused','match_classification','observed_change','causal_attribution')`,
    )
    expect(derived.rows).toHaveLength(0)
  })

  it("interventions append, correct by supersession, and reject update/delete/truncate", async () => {
    const biz = await setupBusiness()
    const { observationId } = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
    const issueId = await claim(biz.businessId, observationId, "$29/month")
    const r = repo(InterventionRepository)
    const first = await Effect.runPromise(r.append(intervention(biz.businessId, [issueId])))
    const snapshot = (await pool.query(`SELECT * FROM interventions WHERE id = $1`, [first.id])).rows[0]
    const correction = await Effect.runPromise(r.append(intervention(biz.businessId, [issueId], { type: "STRUCTURED_DATA_UPDATED", supersedesId: first.id, correctionReason: "wrong type" })))
    expect(correction.supersedesId).toBe(first.id)
    expect((await pool.query(`SELECT * FROM interventions WHERE id = $1`, [first.id])).rows[0]).toEqual(snapshot)
    expect((await Effect.runPromise(r.listByIssue(biz.businessId, issueId))).map((i) => i.id)).toEqual([first.id, correction.id])

    await expect(pool.query(`UPDATE interventions SET notes = 'changed' WHERE id = $1`, [first.id])).rejects.toThrow(/append-only/)
    await expect(pool.query(`DELETE FROM interventions WHERE id = $1`, [first.id])).rejects.toThrow(/append-only/)
    await expect(pool.query(`UPDATE intervention_issues SET issue_id = issue_id WHERE intervention_id = $1`, [first.id])).rejects.toThrow(/append-only/)
    await expect(pool.query(`DELETE FROM intervention_issues WHERE intervention_id = $1`, [first.id])).rejects.toThrow(/append-only/)
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await expect(client.query(`TRUNCATE interventions CASCADE`)).rejects.toThrow(/append-only/)
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
    expect((await pool.query(`SELECT * FROM interventions WHERE id = $1`, [first.id])).rows[0]).toEqual(snapshot)
  })

  it("rejects invalid corrections and cross-tenant intervention links", async () => {
    const a = await setupBusiness()
    const b = await setupBusiness()
    const aObs = await observe(a, "$29/month", "2026-10-01T00:00:00.000Z")
    const bObs = await observe(b, "$29/month", "2026-10-01T00:00:00.000Z")
    const aIssue = await claim(a.businessId, aObs.observationId, "$29/month")
    const bIssue = await claim(b.businessId, bObs.observationId, "$29/month")
    const r = repo(InterventionRepository)
    const first = await Effect.runPromise(r.append(intervention(a.businessId, [aIssue])))
    const noReason = await Effect.runPromiseExit(r.append(intervention(a.businessId, [aIssue], { supersedesId: first.id })))
    expect(Exit.isFailure(noReason)).toBe(true)
    await expect(pool.query(
      `INSERT INTO interventions (business_id, type, target, performed_at, actor, supersedes_id) VALUES ($1,'OTHER','t',now(),'HUMAN',$2)`,
      [a.businessId, first.id],
    )).rejects.toThrow(/check constraint/)
    // Cross-tenant: business A's intervention cannot reference business B's issue.
    expect(Exit.isFailure(await Effect.runPromiseExit(r.append(intervention(a.businessId, [bIssue]))))).toBe(true)
    // Cross-tenant supersession is rejected at the database layer.
    await expect(pool.query(
      `INSERT INTO interventions (business_id, type, target, performed_at, actor, supersedes_id, correction_reason) VALUES ($1,'OTHER','t',now(),'HUMAN',$2,'x')`,
      [b.businessId, first.id],
    )).rejects.toThrow(/another business/)
    expect(await Effect.runPromise(r.listByIssue(b.businessId, aIssue))).toHaveLength(0)
  })

  it("concurrent appends: independent interventions all land; competing corrections serialize to one", async () => {
    const biz = await setupBusiness()
    const { observationId } = await observe(biz, "$29/month", "2026-10-01T00:00:00.000Z")
    const issueId = await claim(biz.businessId, observationId, "$29/month")
    const r = repo(InterventionRepository)
    const many = await Promise.all(Array.from({ length: 5 }, (_, i) => Effect.runPromise(r.append(intervention(biz.businessId, [issueId], { notes: `n${i}` })))))
    expect(new Set(many.map((m) => m.id)).size).toBe(5)
    const target = many[0]!
    const racers = await Promise.all(
      Array.from({ length: 4 }, (_, i) => Effect.runPromiseExit(r.append(intervention(biz.businessId, [issueId], { supersedesId: target.id, correctionReason: `c${i}` })))),
    )
    expect(racers.filter(Exit.isSuccess)).toHaveLength(1)
    expect((await pool.query(`SELECT count(*)::int AS n FROM interventions WHERE supersedes_id = $1`, [target.id])).rows[0]["n"]).toBe(1)
  })

  it("re-observation links are immutable lineage with database-enforced consistency", async () => {
    const l = await acceptanceLineage()
    const r = repo(ReobservationRepository)
    expect((await Effect.runPromise(r.listByIssue(l.businessId, l.issueId))).map((x) => x.id)).toEqual([l.link.id])
    await expect(pool.query(`UPDATE reobservations SET intervention_id = NULL WHERE id = $1`, [l.link.id])).rejects.toThrow(/append-only/)
    await expect(pool.query(`DELETE FROM reobservations WHERE id = $1`, [l.link.id])).rejects.toThrow(/append-only/)
    // Duplicate link, also under concurrency: exactly one row survives.
    const dupes = await Promise.all([0, 1].map(() => Effect.runPromiseExit(r.append({
      businessId: l.businessId, originalObservationId: l.before.observationId, issueId: l.issueId, interventionId: null, observationId: l.after.observationId,
    }))))
    expect(dupes.every(Exit.isFailure)).toBe(true)
    // "Later" observation collected before the original.
    const earlier = await observe(l, "$29/month", "2025-01-01T00:00:00.000Z")
    expect(Exit.isFailure(await Effect.runPromiseExit(r.append({
      businessId: l.businessId, originalObservationId: l.before.observationId, issueId: l.issueId, interventionId: null, observationId: earlier.observationId,
    })))).toBe(true)
    // Another business cannot link to this issue.
    const other = await setupBusiness()
    const foreign = await observe(other, "$39/month", "2026-10-03T00:00:00.000Z")
    expect(Exit.isFailure(await Effect.runPromiseExit(r.append({
      businessId: other.businessId, originalObservationId: l.before.observationId, issueId: l.issueId, interventionId: null, observationId: foreign.observationId,
    })))).toBe(true)
    // An intervention must be linked to the issue it is cited for.
    const unrelatedIssue = await claim(l.businessId, l.before.observationId, "unrelated")
    const unrelated = await Effect.runPromise(repo(InterventionRepository).append(intervention(l.businessId, [unrelatedIssue])))
    const third = await observe(l, "$39/month", "2026-10-04T00:00:00.000Z")
    expect(Exit.isFailure(await Effect.runPromiseExit(r.append({
      businessId: l.businessId, originalObservationId: l.before.observationId, issueId: l.issueId, interventionId: unrelated.id, observationId: third.observationId,
    })))).toBe(true)
  })

  it("rejects raw bytes that do not hash to the reported digest", async () => {
    const biz = await setupBusiness()
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'SUCCEEDED') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
    const exit = await runExit(Effect.flatMap(ObservationRepository, (r) => r.create({
      businessId: biz.businessId, checkRunId: runId, provider: "mock", requestedModel: null, observedModel: null,
      collectedAt: "2026-10-01T00:00:00.000Z", answerText: "x", retrievalMode: "unknown", rawResponse: { x: 1 },
      rawDigest: sha(unique("other")), rawBytesHex: Buffer.from("{}").toString("hex"), citations: [],
    })))
    expect(Exit.isFailure(exit)).toBe(true)
    expect((await pool.query(`SELECT count(*)::int AS n FROM observations WHERE check_run_id = $1`, [runId])).rows[0]["n"]).toBe(0)
  })

  it("evidence packets preserve known actor identity and UNKNOWN for historical nulls", async () => {
    const l = await acceptanceLineage()
    // Protocol V1 requires one linear correction chain per packet, so the
    // known-identity row is a correction of the historical NULL row (same
    // issues, enforced by the repository) — exactly the dogfood situation.
    const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const correction = await runFx(Effect.flatMap(InterventionRepository, (r) =>
      r.append(intervention(l.businessId, [l.issueId], {
        type: "STRUCTURED_DATA_UPDATED",
        actorId: userId,
        notes: "authenticated record",
        supersedesId: l.intervention.id,
        correctionReason: "record who performed the action",
      }))))
    const packet = await runFx(exportIssuePacket({
      accountId: l.accountId, businessId: l.businessId, issueId: l.issueId, generatedAt: "2026-10-05T00:00:00.000Z",
    }))
    expect(packet).not.toBeNull()
    const byId = new Map(packet!.interventions.map((i) => [i.id, i]))
    // Historical NULL stays explicitly unknown, never fabricated.
    expect(byId.get(l.intervention.id)?.actor_id).toEqual({ state: "UNKNOWN" })
    // Authenticated record carries the user id into the sealed packet.
    expect(byId.get(correction.id)?.actor).toBe("HUMAN")
    expect(byId.get(correction.id)?.actor_id).toEqual({ state: "KNOWN", value: userId })
  })

  it("exports the complete PART 11 lineage as a valid, deterministic packet", async () => {
    const l = await acceptanceLineage()
    const exportAt = (embedRawEvidence = false) => runFx(exportIssuePacket({
      accountId: l.accountId, businessId: l.businessId, issueId: l.issueId, generatedAt: "2026-10-05T00:00:00.000Z", embedRawEvidence,
    }))
    const packet = await exportAt()
    expect(packet).not.toBeNull()
    if (!packet) return
    expect(validatePacket(JSON.parse(serializePacket(packet))).packet_digest).toBe(packet.packet_digest)
    expect(serializePacket((await exportAt())!)).toBe(serializePacket(packet))

    expect(packet.facts.map((f) => f.value_text)).toEqual(["$39/month"])
    expect(packet.claims.map((c) => c.text)).toEqual(["$29/month"])
    expect(packet.judgments.map((j) => j.verdict)).toEqual(["INSUFFICIENT_EVIDENCE", "CONTRADICTED"])
    expect(packet.issue.state).toBe("WRONG")
    expect(packet.interventions.map((i) => i.id)).toEqual([l.intervention.id])
    expect(packet.reobservation_claims.map((c) => c.text)).toEqual(["$39/month"])
    expect(packet.reobservation_judgments.map((j) => j.verdict)).toEqual(["SUPPORTED"])
    expect(packet.reobservations[0]).toMatchObject({ match_classification: "EXACT_MATCH", outcome: "OBSERVED_CORRECTION", causal_attribution: "UNKNOWN" })
    expect(packet.synthetic).toBe(true)
    expect(packet.original_observation.measurement.surface.kind).toBe("MOCK")
    expect(packet.original_observation.raw_evidence.embedded_bytes_base64).toBeUndefined()
    expect(packet.explicit_unknowns).toContainEqual({ subject_id: l.issueId, field: "causal_attribution" })
    expect(packet.explicit_unknowns).toContainEqual({ subject_id: l.intervention.id, field: "actor_id" })
    expect(renderEvidencePacket(packet)).toMatch(/^SYNTHETIC DATA\./)

    const embedded = await exportAt(true)
    expect(Buffer.from(embedded!.original_observation.raw_evidence.embedded_bytes_base64!, "base64").toString()).toBe(l.before.bytes)
  })

  it("lineage is tenant-scoped by account and business", async () => {
    const l = await acceptanceLineage()
    const other = await setupBusiness()
    const lineage = repo(EvidenceLineageRepository)
    expect(await Effect.runPromise(lineage.loadIssue(l.accountId, l.businessId, l.issueId))).not.toBeNull()
    expect(await Effect.runPromise(lineage.loadIssue(other.accountId, l.businessId, l.issueId))).toBeNull()
    expect(await Effect.runPromise(lineage.loadIssue(other.accountId, other.businessId, l.issueId))).toBeNull()
    expect(await runFx(exportIssuePacket({ accountId: other.accountId, businessId: l.businessId, issueId: l.issueId, generatedAt: "2026-10-05T00:00:00.000Z" }))).toBeNull()
  })

  it("preserves historical fact versions and judgment history across supersession", async () => {
    const biz = await setupBusiness()
    const before = await observe(biz, "$39/month", "2026-10-01T00:00:00.000Z")
    const issueId = await claim(biz.businessId, before.observationId, "$39/month")
    await judge(biz.businessId, issueId, "SUPPORTED", [biz.factId])
    // Authority changes before the re-observation: v1 superseded by v2.
    await pool.query(`UPDATE authoritative_facts SET status = 'SUPERSEDED', valid_until = '2026-10-01T12:00:00Z' WHERE id = $1`, [biz.factId])
    const v2 = (await pool.query(
      `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, version, supersedes_id, valid_from) VALUES ($1,'Acme Starter','monthly price','$49/month','CURRENCY',2,$2,'2026-10-01T12:00:00Z') RETURNING id`,
      [biz.businessId, biz.factId],
    )).rows[0]["id"] as string
    const after = await observe(biz, "$39/month", "2026-10-02T00:00:00.000Z")
    await runFx(Effect.flatMap(ReobservationRepository, (r) => r.append({ businessId: biz.businessId, originalObservationId: before.observationId, issueId, interventionId: null, observationId: after.observationId })))
    const afterClaim = await claim(biz.businessId, after.observationId, "$39/month")
    await judge(biz.businessId, afterClaim, "CONTRADICTED", [v2])
    const packet = await runFx(exportIssuePacket({ accountId: biz.accountId, businessId: biz.businessId, issueId, generatedAt: "2026-10-05T00:00:00.000Z" }))
    expect(packet!.facts.map((f) => [f.version, f.value_text])).toEqual([[1, "$39/month"], [2, "$49/month"]])
    expect(packet!.reobservations[0]).toMatchObject({ before_verdict: "SUPPORTED", after_verdict: "CONTRADICTED", outcome: "OBSERVED_REGRESSION" })
    expect(renderEvidencePacket(packet!)).toContain("The two judgments used different fact versions.")
  })

  it("exports pre-protocol observations with explicit unknowns instead of guesses", async () => {
    const biz = await setupBusiness()
    const runId = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status, provider, requested_model) VALUES ($1,$2,'SUCCEEDED','9router','pin-a') RETURNING id`, [biz.businessId, biz.questionId])).rows[0]["id"] as string
    const digest = sha(unique("legacy"))
    const rawId = (await pool.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') RETURNING id`, [digest])).rows[0]["id"] as string
    const obsId = (await pool.query(
      `INSERT INTO observations (business_id, check_run_id, provider, requested_model, collected_at, answer_text, retrieval_mode, raw_evidence_id, raw_digest) VALUES ($1,$2,'9router','pin-a','2026-09-01T00:00:00Z','$29/month','unknown',$3,$4) RETURNING id`,
      [biz.businessId, runId, rawId, digest],
    )).rows[0]["id"] as string
    const issueId = await claim(biz.businessId, obsId, "$29/month")
    const packet = await runFx(exportIssuePacket({ accountId: biz.accountId, businessId: biz.businessId, issueId, generatedAt: "2026-10-05T00:00:00.000Z" }))
    const surface = packet!.original_observation.measurement.surface
    expect(surface.kind).toBe("ROUTER_API")
    expect(surface.requested_model).toEqual({ state: "KNOWN", value: "pin-a" })
    expect(surface.observed_model).toEqual({ state: "UNKNOWN" })
    expect(packet!.synthetic).toBe(false)
    expect(packet!.issue.state).toBe("NEEDS_REVIEW")
    for (const field of ["measurement.measurement_configuration", "provider_metadata", "surface.search_mode", "surface.observed_model"]) {
      expect(packet!.explicit_unknowns).toContainEqual({ subject_id: obsId, field })
    }
    expect(Exit.isFailure(await runExit(exportIssuePacket({ accountId: biz.accountId, businessId: biz.businessId, issueId, generatedAt: "2026-10-05T00:00:00.000Z", embedRawEvidence: true })))).toBe(true)
  })
})
