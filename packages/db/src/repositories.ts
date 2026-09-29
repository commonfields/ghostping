// Effect repository services over PostgreSQL (@effect/sql-pg).
// Explicit SQL; no ORM. Every customer-data query is account-scoped.
import { Context, Effect, Layer } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"

export type DbEffect<A> = Effect.Effect<A, SqlError>

// Row helpers: pg returns UUIDs as strings, timestamptz as Date|string.
const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v)

// ---------------------------------------------------------------------------
// Business repository
// ---------------------------------------------------------------------------
export interface BusinessRow {
  readonly id: string
  readonly accountId: string
  readonly name: string
  readonly createdAt: string
}

export class BusinessRepository extends Context.Tag("BusinessRepository")<
  BusinessRepository,
  {
    readonly create: (accountId: string, name: string) => DbEffect<BusinessRow>
    readonly list: (accountId: string) => DbEffect<ReadonlyArray<BusinessRow>>
    readonly getScoped: (accountId: string, id: string) => DbEffect<BusinessRow | null>
  }
>() {}

export const BusinessRepositoryLive = Layer.effect(
  BusinessRepository,
  Effect.map(PgClient.PgClient, (sql) => ({
    create: (accountId: string, name: string) =>
      sql`INSERT INTO businesses (account_id, name) VALUES (${accountId}, ${name}) RETURNING id, account_id, name, created_at`.pipe(
        Effect.map((rows) => {
          const r = (rows as Array<Record<string, unknown>>)[0] as Record<string, unknown>
          return {
            id: String(r["id"]),
            accountId: String(r["account_id"]),
            name: String(r["name"]),
            createdAt: iso(r["created_at"]),
          }
        }),
      ),
    list: (accountId: string) =>
      sql`SELECT id, account_id, name, created_at FROM businesses WHERE account_id = ${accountId} ORDER BY created_at ASC`.pipe(
        Effect.map((rows) =>
          (rows as Array<Record<string, unknown>>).map((r) => ({
            id: String(r["id"]),
            accountId: String(r["account_id"]),
            name: String(r["name"]),
            createdAt: iso(r["created_at"]),
          })),
        ),
      ),
    getScoped: (accountId: string, id: string) =>
      sql`SELECT id, account_id, name, created_at FROM businesses WHERE id = ${id} AND account_id = ${accountId}`.pipe(
        Effect.map((rows) => {
          const r = (rows as Array<Record<string, unknown>>)[0]
          if (!r) return null
          return {
            id: String(r["id"]),
            accountId: String(r["account_id"]),
            name: String(r["name"]),
            createdAt: iso(r["created_at"]),
          }
        }),
      ),
  })),
)

// ---------------------------------------------------------------------------
// Fact repository
// ---------------------------------------------------------------------------
export interface FactRow {
  readonly id: string
  readonly businessId: string
  readonly subject: string
  readonly predicate: string
  readonly valueText: string
  readonly valueType: string
  readonly status: string
  readonly version: number
  readonly supersedesId: string | null
  readonly validFrom: string
  readonly validUntil: string | null
  readonly sourceKind: string
  readonly createdAt: string
}

const mapFact = (r: Record<string, unknown>): FactRow => ({
  id: String(r["id"]),
  businessId: String(r["business_id"]),
  subject: String(r["subject"]),
  predicate: String(r["predicate"]),
  valueText: String(r["value_text"]),
  valueType: String(r["value_type"]),
  status: String(r["status"]),
  version: Number(r["version"]),
  supersedesId: (r["supersedes_id"] as string | null) ?? null,
  validFrom: iso(r["valid_from"]),
  validUntil: (r["valid_until"] as Date | string | null) == null ? null : iso(r["valid_until"]),
  sourceKind: String(r["source_kind"]),
  createdAt: iso(r["created_at"]),
})

export class FactRepository extends Context.Tag("FactRepository")<
  FactRepository,
  {
    readonly create: (input: {
      businessId: string
      subject: string
      predicate: string
      valueText: string
      valueType: string
      validFrom: string
      validUntil: string | null
      sourceKind: string
    }) => DbEffect<FactRow>
    readonly listByBusiness: (businessId: string) => DbEffect<ReadonlyArray<FactRow>>
    readonly getScoped: (businessId: string, id: string) => DbEffect<FactRow | null>
    readonly supersede: (input: {
      businessId: string
      factId: string
      valueText: string
      valueType: string
      validFrom: string
      validUntil: string | null
      sourceKind: string
    }) => DbEffect<FactRow>
    readonly retire: (businessId: string, factId: string) => DbEffect<FactRow | null>
    readonly activeOverlapping: (input: {
      businessId: string
      subject: string
      predicate: string
      validFrom: string
      validUntil: string | null
      excludeId?: string
    }) => DbEffect<ReadonlyArray<FactRow>>
  }
>() {}

export const FactRepositoryLive = Layer.effect(
  FactRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    create: (input) =>
      Effect.gen(function*() {
        const rows = (yield* sql`
          INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, valid_until, source_kind)
          VALUES (${input.businessId}, ${input.subject}, ${input.predicate}, ${input.valueText}, ${input.valueType}, ${input.validFrom}::timestamptz, ${input.validUntil}::timestamptz, ${input.sourceKind})
          RETURNING *`) as Array<Record<string, unknown>>
        return mapFact(rows[0] as Record<string, unknown>)
      }),
    listByBusiness: (businessId: string) =>
      sql`SELECT * FROM authoritative_facts WHERE business_id = ${businessId} ORDER BY predicate ASC, version ASC`.pipe(
        Effect.map((rows) => (rows as Array<Record<string, unknown>>).map(mapFact)),
      ),
    getScoped: (businessId: string, id: string) =>
      sql`SELECT * FROM authoritative_facts WHERE id = ${id} AND business_id = ${businessId}`.pipe(
        Effect.map((rows) => {
          const r = (rows as Array<Record<string, unknown>>)[0]
          return r ? mapFact(r) : null
        }),
      ),
    supersede: (input) =>
      Effect.gen(function*() {
        const prev = (yield* sql`SELECT * FROM authoritative_facts WHERE id = ${input.factId} AND business_id = ${input.businessId}`) as Array<
          Record<string, unknown>
        >
        const p = prev[0]
        if (!p) return yield* Effect.dieMessage("FactNotFound")
        yield* sql`UPDATE authoritative_facts SET status = 'SUPERSEDED' WHERE id = ${input.factId}`
        const rows = (yield* sql`
          INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, version, supersedes_id, valid_from, valid_until, source_kind)
          VALUES (${input.businessId}, ${String(p["subject"])}, ${String(p["predicate"])}, ${input.valueText}, ${input.valueType}, ${Number(p["version"]) + 1}, ${input.factId}, ${input.validFrom}::timestamptz, ${input.validUntil}::timestamptz, ${input.sourceKind})
          RETURNING *`) as Array<Record<string, unknown>>
        return mapFact(rows[0] as Record<string, unknown>)
      }),
    retire: (businessId: string, factId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`
          UPDATE authoritative_facts SET status = 'RETIRED'
          WHERE id = ${factId} AND business_id = ${businessId} RETURNING *`) as Array<
          Record<string, unknown>
        >
        const r = rows[0]
        return r ? mapFact(r) : null
      }),
    activeOverlapping: (input) =>
      sql`
        SELECT * FROM authoritative_facts
        WHERE business_id = ${input.businessId} AND subject = ${input.subject} AND predicate = ${input.predicate}
          AND status = 'ACTIVE'
          AND tstzrange(valid_from, valid_until, '[)') && tstzrange(${input.validFrom}::timestamptz, ${input.validUntil}::timestamptz, '[)')`.pipe(
        Effect.map((rows) =>
          (rows as Array<Record<string, unknown>>)
            .map(mapFact)
            .filter((f) => (input.excludeId ? f.id !== input.excludeId : true)),
        ),
      ),
  })),
)

// ---------------------------------------------------------------------------
// Question repository
// ---------------------------------------------------------------------------
export interface QuestionRow {
  readonly id: string
  readonly businessId: string
  readonly label: string | null
  readonly prompt: string
  readonly origin: string
  readonly active: boolean
  readonly createdAt: string
}

export class QuestionRepository extends Context.Tag("QuestionRepository")<
  QuestionRepository,
  {
    readonly create: (input: {
      businessId: string
      label: string | null
      prompt: string
      origin: string
    }) => DbEffect<QuestionRow>
    readonly listByBusiness: (businessId: string) => DbEffect<ReadonlyArray<QuestionRow>>
    readonly getScoped: (businessId: string, id: string) => DbEffect<QuestionRow | null>
  }
>() {}

export const QuestionRepositoryLive = Layer.effect(
  QuestionRepository,
  Effect.map(PgClient.PgClient, (sql) => ({
    create: (input) =>
      sql`INSERT INTO buyer_questions (business_id, label, prompt, origin) VALUES (${input.businessId}, ${input.label}, ${input.prompt}, ${input.origin}) RETURNING id, business_id, label, prompt, origin, active, created_at`.pipe(
        Effect.map((rows) => {
          const r = (rows as Array<Record<string, unknown>>)[0] as Record<string, unknown>
          return {
            id: String(r["id"]),
            businessId: String(r["business_id"]),
            label: (r["label"] as string | null) ?? null,
            prompt: String(r["prompt"]),
            origin: String(r["origin"]),
            active: Boolean(r["active"]),
            createdAt: iso(r["created_at"]),
          }
        }),
      ),
    listByBusiness: (businessId: string) =>
      sql`SELECT id, business_id, label, prompt, origin, active, created_at FROM buyer_questions WHERE business_id = ${businessId} ORDER BY created_at ASC`.pipe(
        Effect.map((rows) =>
          (rows as Array<Record<string, unknown>>).map((r) => ({
            id: String(r["id"]),
            businessId: String(r["business_id"]),
            label: (r["label"] as string | null) ?? null,
            prompt: String(r["prompt"]),
            origin: String(r["origin"]),
            active: Boolean(r["active"]),
            createdAt: iso(r["created_at"]),
          })),
        ),
      ),
    getScoped: (businessId: string, id: string) =>
      sql`SELECT id, business_id, label, prompt, origin, active, created_at FROM buyer_questions WHERE id = ${id} AND business_id = ${businessId}`.pipe(
        Effect.map((rows) => {
          const r = (rows as Array<Record<string, unknown>>)[0]
          if (!r) return null
          return {
            id: String(r["id"]),
            businessId: String(r["business_id"]),
            label: (r["label"] as string | null) ?? null,
            prompt: String(r["prompt"]),
            origin: String(r["origin"]),
            active: Boolean(r["active"]),
            createdAt: iso(r["created_at"]),
          }
        }),
      ),
  })),
)

// ---------------------------------------------------------------------------
// CheckRun repository (includes SKIP LOCKED claim)
// ---------------------------------------------------------------------------
export interface CheckRunRow {
  readonly id: string
  readonly businessId: string
  readonly questionId: string
  readonly provider: string
  readonly requestedModel: string | null
  readonly status: string
  readonly queuedAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly failureClass: string | null
  readonly failureDetailSafe: string | null
}

const mapRun = (r: Record<string, unknown>): CheckRunRow => ({
  id: String(r["id"]),
  businessId: String(r["business_id"]),
  questionId: String(r["question_id"]),
  provider: String(r["provider"]),
  requestedModel: (r["requested_model"] as string | null) ?? null,
  status: String(r["status"]),
  queuedAt: iso(r["queued_at"]),
  startedAt: (r["started_at"] as unknown) == null ? null : iso(r["started_at"]),
  completedAt: (r["completed_at"] as unknown) == null ? null : iso(r["completed_at"]),
  failureClass: (r["failure_class"] as string | null) ?? null,
  failureDetailSafe: (r["failure_detail_safe"] as string | null) ?? null,
})

export class CheckRunRepository extends Context.Tag("CheckRunRepository")<
  CheckRunRepository,
  {
    readonly enqueue: (input: {
      businessId: string
      questionId: string
      provider: string
      requestedModel: string | null
    }) => DbEffect<CheckRunRow>
    readonly listByBusiness: (businessId: string) => DbEffect<ReadonlyArray<CheckRunRow>>
    readonly getScoped: (businessId: string, id: string) => DbEffect<CheckRunRow | null>
    readonly claimOne: () => DbEffect<CheckRunRow | null>
    readonly markRunning: (id: string) => DbEffect<void>
    readonly markFinished: (
      id: string,
      status: "SUCCEEDED" | "FAILED",
      failureClass: string | null,
      failureDetailSafe: string | null,
    ) => DbEffect<void>
  }
>() {}

export const CheckRunRepositoryLive = Layer.effect(
  CheckRunRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    enqueue: (input) =>
      sql`INSERT INTO check_runs (business_id, question_id, provider, requested_model) VALUES (${input.businessId}, ${input.questionId}, ${input.provider}, ${input.requestedModel}) RETURNING *`.pipe(
        Effect.map((rows) => mapRun((rows as Array<Record<string, unknown>>)[0] as Record<string, unknown>)),
      ),
    listByBusiness: (businessId: string) =>
      sql`SELECT * FROM check_runs WHERE business_id = ${businessId} ORDER BY queued_at DESC LIMIT 100`.pipe(
        Effect.map((rows) => (rows as Array<Record<string, unknown>>).map(mapRun)),
      ),
    getScoped: (businessId: string, id: string) =>
      sql`SELECT * FROM check_runs WHERE id = ${id} AND business_id = ${businessId}`.pipe(
        Effect.map((rows) => {
          const r = (rows as Array<Record<string, unknown>>)[0]
          return r ? mapRun(r) : null
        }),
      ),
    claimOne: () =>
      Effect.gen(function*() {
        const rows = (yield* sql`
          SELECT * FROM check_runs WHERE status = 'QUEUED' ORDER BY queued_at ASC LIMIT 1
          FOR UPDATE SKIP LOCKED`) as Array<Record<string, unknown>>
        const r = rows[0]
        if (!r) return null
        yield* sql`UPDATE check_runs SET status = 'RUNNING', started_at = now() WHERE id = ${String(r["id"])} AND status = 'QUEUED'`
        const after = (yield* sql`SELECT * FROM check_runs WHERE id = ${String(r["id"])}`) as Array<
          Record<string, unknown>
        >
        const a = after[0]
        if (!a || String(a["status"]) !== "RUNNING") return null
        return mapRun(a)
      }),
    markRunning: (id: string) =>
      sql`UPDATE check_runs SET status = 'RUNNING', started_at = now() WHERE id = ${id}`.pipe(Effect.asVoid),
    markFinished: (id: string, status, failureClass, failureDetailSafe) =>
      sql`UPDATE check_runs SET status = ${status}, completed_at = now(), failure_class = ${failureClass}, failure_detail_safe = ${failureDetailSafe} WHERE id = ${id}`.pipe(
        Effect.asVoid,
      ),
  })),
)

// ---------------------------------------------------------------------------
// Observation repository (append-only; no update/delete exposed)
// ---------------------------------------------------------------------------
export interface ObservationRow {
  readonly id: string
  readonly businessId: string
  readonly checkRunId: string
  readonly provider: string
  readonly requestedModel: string | null
  readonly observedModel: string | null
  readonly collectedAt: string
  readonly answerText: string
  readonly retrievalMode: string
  readonly rawEvidenceId: string
  readonly rawDigest: string
  readonly citations: ReadonlyArray<{
    readonly uri: string | null
    readonly title: string | null
    readonly position: number | null
    readonly attributed: boolean
  }>
}

export class ObservationRepository extends Context.Tag("ObservationRepository")<
  ObservationRepository,
  {
    readonly create: (input: {
      businessId: string
      checkRunId: string
      provider: string
      requestedModel: string | null
      observedModel: string | null
      collectedAt: string
      answerText: string
      retrievalMode: string
      rawResponse: unknown
      rawDigest: string
      citations: ReadonlyArray<{
        readonly uri: string | null
        readonly title: string | null
        readonly position: number | null
        readonly attributed: boolean
      }>
    }) => DbEffect<ObservationRow>
    readonly getScoped: (businessId: string, id: string) => DbEffect<ObservationRow | null>
    readonly getByCheckRun: (checkRunId: string) => DbEffect<ObservationRow | null>
  }
>() {}

export const ObservationRepositoryLive = Layer.effect(
  ObservationRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => {
    const loadCitations = (observationId: string) =>
      sql`SELECT uri, title, position, attributed FROM observation_citations WHERE observation_id = ${observationId}`.pipe(
        Effect.map((rows) =>
          (rows as Array<Record<string, unknown>>).map((r) => ({
            uri: (r["uri"] as string | null) ?? null,
            title: (r["title"] as string | null) ?? null,
            position: (r["position"] as number | null) ?? null,
            attributed: Boolean(r["attributed"]),
          })),
        ),
      )
    return {
      create: (input) =>
        Effect.gen(function*() {
          const rawText = JSON.stringify(input.rawResponse)
          const raw = (yield* sql`
            INSERT INTO raw_evidence (digest, content_text) VALUES (${input.rawDigest}, ${rawText})
            ON CONFLICT (digest) DO UPDATE SET digest = EXCLUDED.digest RETURNING id, digest`) as Array<
            Record<string, unknown>
          >
          const rawId = String((raw[0] as Record<string, unknown>)["id"])
          const obs = (yield* sql`
            INSERT INTO observations (business_id, check_run_id, provider, requested_model, observed_model, collected_at, answer_text, retrieval_mode, raw_evidence_id, raw_digest)
            VALUES (${input.businessId}, ${input.checkRunId}, ${input.provider}, ${input.requestedModel}, ${input.observedModel}, ${input.collectedAt}::timestamptz, ${input.answerText}, ${input.retrievalMode}, ${rawId}, ${input.rawDigest})
            RETURNING *`) as Array<Record<string, unknown>>
          const o = obs[0] as Record<string, unknown>
          for (const c of input.citations) {
            yield* sql`INSERT INTO observation_citations (observation_id, uri, title, position, attributed) VALUES (${String(o["id"])}, ${c.uri}, ${c.title}, ${c.position}, ${c.attributed})`
          }
          const citations = yield* loadCitations(String(o["id"]))
          return {
            id: String(o["id"]),
            businessId: String(o["business_id"]),
            checkRunId: String(o["check_run_id"]),
            provider: String(o["provider"]),
            requestedModel: (o["requested_model"] as string | null) ?? null,
            observedModel: (o["observed_model"] as string | null) ?? null,
            collectedAt: iso(o["collected_at"]),
            answerText: String(o["answer_text"]),
            retrievalMode: String(o["retrieval_mode"]),
            rawEvidenceId: String(o["raw_evidence_id"]),
            rawDigest: String(o["raw_digest"]),
            citations,
          }
        }),
      getScoped: (businessId: string, id: string) =>
        Effect.gen(function*() {
          const rows = (yield* sql`SELECT * FROM observations WHERE id = ${id} AND business_id = ${businessId}`) as Array<
            Record<string, unknown>
          >
          const o = rows[0]
          if (!o) return null
          const citations = yield* loadCitations(String(o["id"]))
          return {
            id: String(o["id"]),
            businessId: String(o["business_id"]),
            checkRunId: String(o["check_run_id"]),
            provider: String(o["provider"]),
            requestedModel: (o["requested_model"] as string | null) ?? null,
            observedModel: (o["observed_model"] as string | null) ?? null,
            collectedAt: iso(o["collected_at"]),
            answerText: String(o["answer_text"]),
            retrievalMode: String(o["retrieval_mode"]),
            rawEvidenceId: String(o["raw_evidence_id"]),
            rawDigest: String(o["raw_digest"]),
            citations,
          }
        }),
      getByCheckRun: (checkRunId: string) =>
        Effect.gen(function*() {
          const rows = (yield* sql`SELECT * FROM observations WHERE check_run_id = ${checkRunId}`) as Array<
            Record<string, unknown>
          >
          const o = rows[0]
          if (!o) return null
          const citations = yield* loadCitations(String(o["id"]))
          return {
            id: String(o["id"]),
            businessId: String(o["business_id"]),
            checkRunId: String(o["check_run_id"]),
            provider: String(o["provider"]),
            requestedModel: (o["requested_model"] as string | null) ?? null,
            observedModel: (o["observed_model"] as string | null) ?? null,
            collectedAt: iso(o["collected_at"]),
            answerText: String(o["answer_text"]),
            retrievalMode: String(o["retrieval_mode"]),
            rawEvidenceId: String(o["raw_evidence_id"]),
            rawDigest: String(o["raw_digest"]),
            citations,
          }
        }),
    }
  }),
)

// ---------------------------------------------------------------------------
// Claim + Judgment repositories
// ---------------------------------------------------------------------------
export interface ClaimRow {
  readonly id: string
  readonly businessId: string
  readonly observationId: string
  readonly text: string
  readonly origin: string
  readonly createdAt: string
}

export class ClaimRepository extends Context.Tag("ClaimRepository")<
  ClaimRepository,
  {
    readonly create: (input: {
      businessId: string
      observationId: string
      text: string
      origin: string
    }) => DbEffect<ClaimRow>
    readonly listByBusiness: (businessId: string) => DbEffect<ReadonlyArray<ClaimRow>>
    readonly getScoped: (businessId: string, id: string) => DbEffect<ClaimRow | null>
  }
>() {}

export const ClaimRepositoryLive = Layer.effect(
  ClaimRepository,
  Effect.map(PgClient.PgClient, (sql) => ({
    create: (input) =>
      sql`INSERT INTO candidate_claims (business_id, observation_id, text, origin) VALUES (${input.businessId}, ${input.observationId}, ${input.text}, ${input.origin}) RETURNING *`.pipe(
        Effect.map((rows) => {
          const r = (rows as Array<Record<string, unknown>>)[0] as Record<string, unknown>
          return {
            id: String(r["id"]),
            businessId: String(r["business_id"]),
            observationId: String(r["observation_id"]),
            text: String(r["text"]),
            origin: String(r["origin"]),
            createdAt: iso(r["created_at"]),
          }
        }),
      ),
    listByBusiness: (businessId: string) =>
      sql`SELECT * FROM candidate_claims WHERE business_id = ${businessId} ORDER BY created_at DESC`.pipe(
        Effect.map((rows) =>
          (rows as Array<Record<string, unknown>>).map((r) => ({
            id: String(r["id"]),
            businessId: String(r["business_id"]),
            observationId: String(r["observation_id"]),
            text: String(r["text"]),
            origin: String(r["origin"]),
            createdAt: iso(r["created_at"]),
          })),
        ),
      ),
    getScoped: (businessId: string, id: string) =>
      sql`SELECT * FROM candidate_claims WHERE id = ${id} AND business_id = ${businessId}`.pipe(
        Effect.map((rows) => {
          const r = (rows as Array<Record<string, unknown>>)[0]
          if (!r) return null
          return {
            id: String(r["id"]),
            businessId: String(r["business_id"]),
            observationId: String(r["observation_id"]),
            text: String(r["text"]),
            origin: String(r["origin"]),
            createdAt: iso(r["created_at"]),
          }
        }),
      ),
  })),
)

export interface JudgmentRow {
  readonly id: string
  readonly businessId: string
  readonly claimId: string
  readonly verdict: string
  readonly notes: string | null
  readonly factIds: ReadonlyArray<string>
  readonly supersedesId: string | null
  readonly superseded: boolean
  readonly createdAt: string
}

export class JudgmentRepository extends Context.Tag("JudgmentRepository")<
  JudgmentRepository,
  {
    readonly create: (input: {
      businessId: string
      claimId: string
      verdict: string
      notes: string | null
      factIds: ReadonlyArray<string>
    }) => DbEffect<JudgmentRow>
    readonly listByClaim: (claimId: string) => DbEffect<ReadonlyArray<JudgmentRow>>
    readonly latestForClaim: (claimId: string) => DbEffect<JudgmentRow | null>
  }
>() {}

export const JudgmentRepositoryLive = Layer.effect(
  JudgmentRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    create: (input) =>
      Effect.gen(function*() {
        // Supersede previous heads (append-only history; old rows stay).
        yield* sql`UPDATE human_judgments SET superseded = true WHERE claim_id = ${input.claimId} AND superseded = false`
        const rows = (yield* sql`
          INSERT INTO human_judgments (business_id, claim_id, verdict, notes)
          VALUES (${input.businessId}, ${input.claimId}, ${input.verdict}, ${input.notes}) RETURNING *`) as Array<
          Record<string, unknown>
        >
        const j = rows[0] as Record<string, unknown>
        for (const fid of input.factIds) {
          yield* sql`INSERT INTO human_judgment_facts (judgment_id, fact_id) VALUES (${String(j["id"])}, ${fid}) ON CONFLICT DO NOTHING`
        }
        const facts = (yield* sql`SELECT fact_id FROM human_judgment_facts WHERE judgment_id = ${String(j["id"])}`) as Array<
          Record<string, unknown>
        >
        return {
          id: String(j["id"]),
          businessId: String(j["business_id"]),
          claimId: String(j["claim_id"]),
          verdict: String(j["verdict"]),
          notes: (j["notes"] as string | null) ?? null,
          factIds: facts.map((f) => String(f["fact_id"])),
          supersedesId: (j["supersedes_id"] as string | null) ?? null,
          superseded: Boolean(j["superseded"]),
          createdAt: iso(j["created_at"]),
        }
      }),
    listByClaim: (claimId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM human_judgments WHERE claim_id = ${claimId} ORDER BY created_at ASC`) as Array<
          Record<string, unknown>
        >
        const out: Array<JudgmentRow> = []
        for (const j of rows) {
          const facts = (yield* sql`SELECT fact_id FROM human_judgment_facts WHERE judgment_id = ${String(j["id"])}`) as Array<
            Record<string, unknown>
          >
          out.push({
            id: String(j["id"]),
            businessId: String(j["business_id"]),
            claimId: String(j["claim_id"]),
            verdict: String(j["verdict"]),
            notes: (j["notes"] as string | null) ?? null,
            factIds: facts.map((f) => String(f["fact_id"])),
            supersedesId: (j["supersedes_id"] as string | null) ?? null,
            superseded: Boolean(j["superseded"]),
            createdAt: iso(j["created_at"]),
          })
        }
        return out
      }),
    latestForClaim: (claimId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM human_judgments WHERE claim_id = ${claimId} AND superseded = false ORDER BY created_at DESC LIMIT 1`) as Array<
          Record<string, unknown>
        >
        const j = rows[0]
        if (!j) return null
        const facts = (yield* sql`SELECT fact_id FROM human_judgment_facts WHERE judgment_id = ${String(j["id"])}`) as Array<
          Record<string, unknown>
        >
        return {
          id: String(j["id"]),
          businessId: String(j["business_id"]),
          claimId: String(j["claim_id"]),
          verdict: String(j["verdict"]),
          notes: (j["notes"] as string | null) ?? null,
          factIds: facts.map((f) => String(f["fact_id"])),
          supersedesId: (j["supersedes_id"] as string | null) ?? null,
          superseded: Boolean(j["superseded"]),
          createdAt: iso(j["created_at"]),
        }
      }),
  })),
)
