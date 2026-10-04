// Effect repository services over PostgreSQL (@effect/sql-pg).
// Explicit SQL; no ORM. Every customer-data query is account-scoped.
import { createHash } from "node:crypto"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { AuthorityError } from "./truth.js"
import {
  BooleanField,
  IntField,
  NullableIntField,
  NullableJsonField,
  NullableTextField,
  NullableTimestampField,
  NullableUuidField,
  TextField,
  TimestampField,
  UuidField,
  decodeRow,
  type RowDecodeError,
} from "./row-codecs.js"

export type DbEffect<A> = Effect.Effect<A, SqlError | RowDecodeError>

// Content-addressed integrity failure: an existing digest maps to different
// bytes than the incoming payload. Fails closed; never overwrites.
export class RawDigestMismatch extends Data.TaggedError("RawDigestMismatch")<{
  readonly digest: string
}> {}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

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

const BusinessSchema = Schema.Struct({
  id: UuidField,
  account_id: UuidField,
  name: TextField,
  created_at: TimestampField,
})

const decodeBusiness = (row: unknown): Effect.Effect<BusinessRow, RowDecodeError> =>
  decodeRow(BusinessSchema, "businesses", row).pipe(
    Effect.map((d) => ({
      id: d.id,
      accountId: d.account_id,
      name: d.name,
      createdAt: iso(d.created_at),
    })),
  )

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
        Effect.flatMap((rows) => decodeBusiness((rows as Array<unknown>)[0])),
      ),
    list: (accountId: string) =>
      sql`SELECT id, account_id, name, created_at FROM businesses WHERE account_id = ${accountId} ORDER BY created_at ASC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeBusiness)),
      ),
    getScoped: (accountId: string, id: string) =>
      sql`SELECT id, account_id, name, created_at FROM businesses WHERE id = ${id} AND account_id = ${accountId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as BusinessRow | null)
          return decodeBusiness(r)
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

const FactSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  subject: TextField,
  predicate: TextField,
  value_text: TextField,
  value_type: TextField,
  status: TextField,
  version: IntField,
  supersedes_id: NullableUuidField,
  valid_from: TimestampField,
  valid_until: NullableTimestampField,
  source_kind: TextField,
  created_at: TimestampField,
})

const decodeFact = (row: unknown): Effect.Effect<FactRow, RowDecodeError> =>
  decodeRow(FactSchema, "authoritative_facts", row).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      subject: d.subject,
      predicate: d.predicate,
      valueText: d.value_text,
      valueType: d.value_type,
      status: d.status,
      version: Number(d.version),
      supersedesId: d.supersedes_id,
      validFrom: iso(d.valid_from),
      validUntil: d.valid_until == null ? null : iso(d.valid_until),
      sourceKind: d.source_kind,
      createdAt: iso(d.created_at),
    })),
  )

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
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => {
    // One active writer: direct hosted mutations fail closed for
    // repository-managed businesses (typed AuthorityError defect, never a
    // silent second truth). The manifest sync bypasses this layer with
    // SET LOCAL ghostping.authority_sync = '1', which the hosted API never sets.
    const assertHostedWritable = (businessId: string, op: string) =>
      Effect.gen(function*() {
        const modes = (yield* sql`SELECT writer FROM business_authority_mode WHERE business_id = ${businessId}`) as Array<
          Record<string, unknown>
        >
        if (modes[0] && String(modes[0]["writer"]) === "REPOSITORY_MANIFEST") {
          return yield* Effect.die(new AuthorityError("FactAuthorityManagedByRepository", `${op} ${businessId}`))
        }
      })
    return {
      create: (input) =>
        Effect.gen(function*() {
          yield* assertHostedWritable(input.businessId, "create")
          const rows = (yield* sql`
          INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, valid_until, source_kind)
          VALUES (${input.businessId}, ${input.subject}, ${input.predicate}, ${input.valueText}, ${input.valueType}, ${input.validFrom}::timestamptz, ${input.validUntil}::timestamptz, ${input.sourceKind})
          RETURNING *`) as Array<unknown>
          return yield* decodeFact(rows[0])
        }),
    listByBusiness: (businessId: string) =>
      sql`SELECT * FROM authoritative_facts WHERE business_id = ${businessId} ORDER BY predicate ASC, version ASC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeFact)),
      ),
    getScoped: (businessId: string, id: string) =>
      sql`SELECT * FROM authoritative_facts WHERE id = ${id} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as FactRow | null)
          return decodeFact(r)
        }),
      ),
    supersede: (input) =>
      Effect.gen(function*() {
        yield* assertHostedWritable(input.businessId, "supersede")
        const prev = (yield* sql`SELECT * FROM authoritative_facts WHERE id = ${input.factId} AND business_id = ${input.businessId}`) as Array<
          unknown
        >
        const p = prev[0]
        if (!p) return yield* Effect.dieMessage("FactNotFound")
        const decodedPrev = yield* decodeFact(p)
        yield* sql`UPDATE authoritative_facts SET status = 'SUPERSEDED' WHERE id = ${input.factId}`
        const rows = (yield* sql`
          INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, version, supersedes_id, valid_from, valid_until, source_kind)
          VALUES (${input.businessId}, ${decodedPrev.subject}, ${decodedPrev.predicate}, ${input.valueText}, ${input.valueType}, ${decodedPrev.version + 1}, ${input.factId}, ${input.validFrom}::timestamptz, ${input.validUntil}::timestamptz, ${input.sourceKind})
          RETURNING *`) as Array<unknown>
        return yield* decodeFact(rows[0])
      }),
    retire: (businessId: string, factId: string) =>
      Effect.gen(function*() {
        yield* assertHostedWritable(businessId, "retire")
        const rows = (yield* sql`
          UPDATE authoritative_facts SET status = 'RETIRED'
          WHERE id = ${factId} AND business_id = ${businessId} RETURNING *`) as Array<
          unknown
        >
        const r = rows[0]
        if (!r) return null
        return yield* decodeFact(r)
      }),
    activeOverlapping: (input) =>
      sql`
        SELECT * FROM authoritative_facts
        WHERE business_id = ${input.businessId} AND subject = ${input.subject} AND predicate = ${input.predicate}
          AND status = 'ACTIVE'
          AND tstzrange(valid_from, valid_until, '[)') && tstzrange(${input.validFrom}::timestamptz, ${input.validUntil}::timestamptz, '[)')`.pipe(
        Effect.flatMap((rows) =>
          Effect.map(
            Effect.forEach(rows as Array<unknown>, decodeFact),
            (facts) => facts.filter((f) => (input.excludeId ? f.id !== input.excludeId : true)),
          ),
        ),
      ),
    }
  }),
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

const QuestionSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  label: NullableTextField,
  prompt: TextField,
  origin: TextField,
  active: BooleanField,
  created_at: TimestampField,
})

const decodeQuestion = (row: unknown): Effect.Effect<QuestionRow, RowDecodeError> =>
  decodeRow(QuestionSchema, "buyer_questions", row).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      label: d.label,
      prompt: d.prompt,
      origin: d.origin,
      active: d.active,
      createdAt: iso(d.created_at),
    })),
  )

export const QuestionRepositoryLive = Layer.effect(
  QuestionRepository,
  Effect.map(PgClient.PgClient, (sql) => ({
    create: (input) =>
      sql`INSERT INTO buyer_questions (business_id, label, prompt, origin) VALUES (${input.businessId}, ${input.label}, ${input.prompt}, ${input.origin}) RETURNING id, business_id, label, prompt, origin, active, created_at`.pipe(
        Effect.flatMap((rows) => decodeQuestion((rows as Array<unknown>)[0])),
      ),
    listByBusiness: (businessId: string) =>
      sql`SELECT id, business_id, label, prompt, origin, active, created_at FROM buyer_questions WHERE business_id = ${businessId} ORDER BY created_at ASC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeQuestion)),
      ),
    getScoped: (businessId: string, id: string) =>
      sql`SELECT id, business_id, label, prompt, origin, active, created_at FROM buyer_questions WHERE id = ${id} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as QuestionRow | null)
          return decodeQuestion(r)
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
  readonly attemptCount: number
}

const CheckRunSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  question_id: UuidField,
  provider: TextField,
  requested_model: NullableTextField,
  status: TextField,
  queued_at: TimestampField,
  started_at: NullableTimestampField,
  completed_at: NullableTimestampField,
  failure_class: NullableTextField,
  failure_detail_safe: NullableTextField,
  attempt_count: NullableIntField,
})

const decodeCheckRun = (row: unknown): Effect.Effect<CheckRunRow, RowDecodeError> =>
  decodeRow(CheckRunSchema, "check_runs", row).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      questionId: d.question_id,
      provider: d.provider,
      requestedModel: d.requested_model,
      status: d.status,
      queuedAt: iso(d.queued_at),
      startedAt: d.started_at == null ? null : iso(d.started_at),
      completedAt: d.completed_at == null ? null : iso(d.completed_at),
      failureClass: d.failure_class,
      failureDetailSafe: d.failure_detail_safe,
      attemptCount: Number(d.attempt_count ?? 0),
    })),
  )

const AttemptCountSchema = Schema.Struct({ attempt_count: IntField })

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
    readonly recordAttempt: (id: string) => DbEffect<number>
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
        Effect.flatMap((rows) => decodeCheckRun((rows as Array<unknown>)[0])),
      ),
    listByBusiness: (businessId: string) =>
      sql`SELECT * FROM check_runs WHERE business_id = ${businessId} ORDER BY queued_at DESC LIMIT 100`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeCheckRun)),
      ),
    getScoped: (businessId: string, id: string) =>
      sql`SELECT * FROM check_runs WHERE id = ${id} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as CheckRunRow | null)
          return decodeCheckRun(r)
        }),
      ),
    claimOne: () =>
      Effect.gen(function*() {
        // Atomic ownership: exactly one worker can transition a given
        // QUEUED row to RUNNING. The CTE locks the candidate and the UPDATE
        // re-checks status = 'QUEUED', so two concurrent claimers can never
        // both receive the same CheckRun. No select-then-update-then-reread.
        const rows = (yield* sql`
          WITH candidate AS (
            SELECT id FROM check_runs
            WHERE status = 'QUEUED'
            ORDER BY queued_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE check_runs AS r
          SET status = 'RUNNING', started_at = now()
          FROM candidate
          WHERE r.id = candidate.id AND r.status = 'QUEUED'
          RETURNING r.*`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeCheckRun(r)
      }),
    markRunning: (id: string) =>
      // Guarded transition: only QUEUED -> RUNNING is legal here.
      sql`UPDATE check_runs SET status = 'RUNNING', started_at = now() WHERE id = ${id} AND status = 'QUEUED'`.pipe(
        Effect.asVoid,
      ),
    recordAttempt: (id: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`UPDATE check_runs SET attempt_count = attempt_count + 1 WHERE id = ${id} RETURNING attempt_count`) as Array<
          unknown
        >
        const decoded = yield* decodeRow(AttemptCountSchema, "check_runs", rows[0])
        return Number(decoded.attempt_count)
      }),
    markFinished: (id: string, status, failureClass, failureDetailSafe) =>
      // Terminal transition: only RUNNING -> SUCCEEDED | FAILED. Terminal
      // rows (SUCCEEDED/FAILED) can never be re-opened via this path.
      sql`UPDATE check_runs SET status = ${status}, completed_at = now(), failure_class = ${failureClass}, failure_detail_safe = ${failureDetailSafe} WHERE id = ${id} AND status = 'RUNNING'`.pipe(
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
  readonly surfaceIdentity: unknown | null
  readonly measurementContext: unknown | null
  readonly synthetic: boolean
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
      rawBytesHex?: string | null
      rawContentType?: string | null
      providerMetadata?: unknown
      surfaceIdentity?: unknown
      measurementContext?: unknown
      synthetic?: boolean
      citations: ReadonlyArray<{
        readonly uri: string | null
        readonly title: string | null
        readonly position: number | null
        readonly attributed: boolean
      }>
    }) => Effect.Effect<ObservationRow, SqlError | RowDecodeError | RawDigestMismatch>
    readonly getScoped: (businessId: string, id: string) => DbEffect<ObservationRow | null>
    readonly getByCheckRun: (checkRunId: string) => DbEffect<ObservationRow | null>
  }
>() {}

const CitationSchema = Schema.Struct({
  uri: NullableTextField,
  title: NullableTextField,
  position: NullableIntField,
  attributed: BooleanField,
})

const ObservationSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  check_run_id: UuidField,
  provider: TextField,
  requested_model: NullableTextField,
  observed_model: NullableTextField,
  collected_at: TimestampField,
  answer_text: TextField,
  retrieval_mode: TextField,
  raw_evidence_id: UuidField,
  raw_digest: TextField,
  surface_identity: NullableJsonField,
  measurement_context: NullableJsonField,
  synthetic: BooleanField,
})

const RawEvidenceSchema = Schema.Struct({
  id: UuidField,
  digest: TextField,
  content_text: TextField,
  raw_bytes_hex: NullableTextField,
})

const decodeObservationBase = (row: unknown) =>
  decodeRow(ObservationSchema, "observations", row).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      checkRunId: d.check_run_id,
      provider: d.provider,
      requestedModel: d.requested_model,
      observedModel: d.observed_model,
      collectedAt: iso(d.collected_at),
      answerText: d.answer_text,
      retrievalMode: d.retrieval_mode,
      rawEvidenceId: d.raw_evidence_id,
      rawDigest: d.raw_digest,
      surfaceIdentity: d.surface_identity,
      measurementContext: d.measurement_context,
      synthetic: d.synthetic,
    })),
  )

export const ObservationRepositoryLive = Layer.effect(
  ObservationRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => {
    const loadCitations = (observationId: string) =>
      sql`SELECT uri, title, position, attributed FROM observation_citations WHERE observation_id = ${observationId}`.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows as Array<unknown>, (r) =>
            decodeRow(CitationSchema, "observation_citations", r).pipe(
              Effect.map((d) => ({
                uri: d.uri,
                title: d.title,
                position: d.position == null ? null : Number(d.position),
                attributed: d.attributed,
              })),
            ),
          ),
        ),
      )
    return {
      create: (input) =>
        Effect.gen(function*() {
          const rawText = JSON.stringify(input.rawResponse)
          // Exact wire bytes are canonical evidence: they must hash to the
          // digest the worker reported, or nothing is stored.
          if (input.rawBytesHex != null && sha256Hex(Buffer.from(input.rawBytesHex, "hex")) !== input.rawDigest) {
            return yield* Effect.fail(new RawDigestMismatch({ digest: input.rawDigest }))
          }
          // Immutable get-or-insert: never UPDATE the existing row (the
          // raw_evidence trigger forbids it). Repeated identical provider
          // payloads share one content-addressed row.
          yield* sql`
            INSERT INTO raw_evidence (digest, content_text, raw_bytes_hex, received_at, provider_metadata, content_type)
            VALUES (${input.rawDigest}, ${rawText}, ${input.rawBytesHex ?? null}, ${input.collectedAt}::timestamptz, ${input.providerMetadata == null ? null : JSON.stringify(input.providerMetadata)}::jsonb, ${input.rawContentType ?? "application/json"})
            ON CONFLICT (digest) DO NOTHING`
          const existing = (yield* sql`SELECT id, digest, content_text, raw_bytes_hex FROM raw_evidence WHERE digest = ${input.rawDigest}`) as Array<
            unknown
          >
          const rawRow = existing[0]
          if (!rawRow) return yield* Effect.dieMessage("raw_evidence insert produced no row")
          const decodedRaw = yield* decodeRow(RawEvidenceSchema, "raw_evidence", rawRow)
          const storedBytes = decodedRaw.raw_bytes_hex
          if (decodedRaw.content_text !== rawText || (storedBytes !== null && input.rawBytesHex != null && storedBytes !== input.rawBytesHex)) {
            // Same digest, different bytes: fail closed, keep the original.
            return yield* Effect.fail(new RawDigestMismatch({ digest: input.rawDigest }))
          }
          const rawId = decodedRaw.id
          const obs = (yield* sql`
            INSERT INTO observations (business_id, check_run_id, provider, requested_model, observed_model, collected_at, answer_text, retrieval_mode, raw_evidence_id, raw_digest, surface_identity, measurement_context, synthetic)
            VALUES (${input.businessId}, ${input.checkRunId}, ${input.provider}, ${input.requestedModel}, ${input.observedModel}, ${input.collectedAt}::timestamptz, ${input.answerText}, ${input.retrievalMode}, ${rawId}, ${input.rawDigest}, ${input.surfaceIdentity == null ? null : JSON.stringify(input.surfaceIdentity)}::jsonb, ${input.measurementContext == null ? null : JSON.stringify(input.measurementContext)}::jsonb, ${input.synthetic ?? false})
            RETURNING *`) as Array<unknown>
          const o = obs[0]
          const base = yield* decodeObservationBase(o)
          for (const c of input.citations) {
            yield* sql`INSERT INTO observation_citations (observation_id, uri, title, position, attributed) VALUES (${base.id}, ${c.uri}, ${c.title}, ${c.position}, ${c.attributed})`
          }
          const citations = yield* loadCitations(base.id)
          return { ...base, citations }
        }),
      getScoped: (businessId: string, id: string) =>
        Effect.gen(function*() {
          const rows = (yield* sql`SELECT * FROM observations WHERE id = ${id} AND business_id = ${businessId}`) as Array<
            unknown
          >
          const o = rows[0]
          if (!o) return null
          const base = yield* decodeObservationBase(o)
          const citations = yield* loadCitations(base.id)
          return { ...base, citations }
        }),
      getByCheckRun: (checkRunId: string) =>
        Effect.gen(function*() {
          const rows = (yield* sql`SELECT * FROM observations WHERE check_run_id = ${checkRunId}`) as Array<
            unknown
          >
          const o = rows[0]
          if (!o) return null
          const base = yield* decodeObservationBase(o)
          const citations = yield* loadCitations(base.id)
          return { ...base, citations }
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

const ClaimSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  observation_id: UuidField,
  text: TextField,
  origin: TextField,
  created_at: TimestampField,
})

const decodeClaim = (row: unknown): Effect.Effect<ClaimRow, RowDecodeError> =>
  decodeRow(ClaimSchema, "candidate_claims", row).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      observationId: d.observation_id,
      text: d.text,
      origin: d.origin,
      createdAt: iso(d.created_at),
    })),
  )

export const ClaimRepositoryLive = Layer.effect(
  ClaimRepository,
  Effect.map(PgClient.PgClient, (sql) => ({
    create: (input) =>
      sql`INSERT INTO candidate_claims (business_id, observation_id, text, origin) VALUES (${input.businessId}, ${input.observationId}, ${input.text}, ${input.origin}) RETURNING *`.pipe(
        Effect.flatMap((rows) => decodeClaim((rows as Array<unknown>)[0])),
      ),
    listByBusiness: (businessId: string) =>
      sql`SELECT * FROM candidate_claims WHERE business_id = ${businessId} ORDER BY created_at DESC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeClaim)),
      ),
    getScoped: (businessId: string, id: string) =>
      sql`SELECT * FROM candidate_claims WHERE id = ${id} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as ClaimRow | null)
          return decodeClaim(r)
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
  readonly createdAt: string
}

const JudgmentSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  claim_id: UuidField,
  verdict: TextField,
  notes: NullableTextField,
  supersedes_id: NullableUuidField,
  created_at: TimestampField,
})

const JudgmentFactSchema = Schema.Struct({ fact_id: UuidField })

const decodeJudgmentFacts = (rows: Array<unknown>): Effect.Effect<ReadonlyArray<string>, RowDecodeError> =>
  Effect.forEach(rows, (r) => decodeRow(JudgmentFactSchema, "human_judgment_facts", r).pipe(Effect.map((d) => d.fact_id)))

const decodeJudgment = (
  j: unknown,
  factIds: ReadonlyArray<string>,
): Effect.Effect<JudgmentRow, RowDecodeError> =>
  decodeRow(JudgmentSchema, "human_judgments", j).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      claimId: d.claim_id,
      verdict: d.verdict,
      notes: d.notes,
      factIds,
      supersedesId: d.supersedes_id,
      createdAt: iso(d.created_at),
    })),
  )

// Current head = the judgment no newer judgment points at:
//   NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id)
// inlined in the queries below.

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
      // Append-only supersession: J1 is never rewritten. J2 carries
      // supersedes_id = J1.id, so J1's historical status derives from J2's
      // existence. Creation is serialized per claim (SELECT the claim
      // FOR UPDATE) so two concurrent reviews form one linear chain,
      // never two current heads.
      sql.withTransaction(
        Effect.gen(function*() {
          const claims = (yield* sql`SELECT id FROM candidate_claims WHERE id = ${input.claimId} FOR UPDATE`) as Array<
            unknown
          >
          if (!claims[0]) return yield* Effect.dieMessage("ClaimNotFound")
          const headRows = (yield* sql`
            SELECT * FROM human_judgments j
            WHERE j.claim_id = ${input.claimId}
              AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id)
            ORDER BY j.created_at DESC LIMIT 1`) as Array<unknown>
          const head = headRows[0]
          const headId = head ? (yield* decodeRow(JudgmentSchema, "human_judgments", head)).id : null
          const rows = (yield* sql`
            INSERT INTO human_judgments (business_id, claim_id, verdict, notes, supersedes_id)
            VALUES (${input.businessId}, ${input.claimId}, ${input.verdict}, ${input.notes}, ${headId})
            RETURNING *`) as Array<unknown>
          const j = rows[0]
          const decodedForId = yield* decodeRow(JudgmentSchema, "human_judgments", j)
          for (const fid of input.factIds) {
            yield* sql`INSERT INTO human_judgment_facts (judgment_id, fact_id) VALUES (${decodedForId.id}, ${fid}) ON CONFLICT DO NOTHING`
          }
          const facts = (yield* sql`SELECT fact_id FROM human_judgment_facts WHERE judgment_id = ${decodedForId.id}`) as Array<
            unknown
          >
          return yield* decodeJudgment(j, yield* decodeJudgmentFacts(facts))
        }),
      ),
    listByClaim: (claimId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM human_judgments WHERE claim_id = ${claimId} ORDER BY created_at ASC`) as Array<
          unknown
        >
        const out: Array<JudgmentRow> = []
        for (const j of rows) {
          const decodedForId = yield* decodeRow(JudgmentSchema, "human_judgments", j)
          const facts = (yield* sql`SELECT fact_id FROM human_judgment_facts WHERE judgment_id = ${decodedForId.id}`) as Array<
            unknown
          >
          out.push(yield* decodeJudgment(j, yield* decodeJudgmentFacts(facts)))
        }
        return out
      }),
    latestForClaim: (claimId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`
          SELECT * FROM human_judgments j
          WHERE j.claim_id = ${claimId}
            AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id)
          ORDER BY j.created_at DESC LIMIT 1`) as Array<unknown>
        const j = rows[0]
        if (!j) return null
        const decodedForId = yield* decodeRow(JudgmentSchema, "human_judgments", j)
        const facts = (yield* sql`SELECT fact_id FROM human_judgment_facts WHERE judgment_id = ${decodedForId.id}`) as Array<
          unknown
        >
        return yield* decodeJudgment(j, yield* decodeJudgmentFacts(facts))
      }),
  })),
)

