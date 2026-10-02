// Evidence Protocol V1 persistence: append-only interventions, re-observation
// links, the tenant-scoped issue lineage query, and packet export.
//
// Only evidence and events are stored. Signatures, match classification,
// observed change, outcomes, and unknowns are derived by @ghostping/protocol
// at export time, so there is exactly one implementation of those rules.
import { createHash } from "node:crypto"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import {
  exportEvidencePacket,
  validatePacket,
  knownValue,
  MeasurementContextV1,
  requestConfigurationForWorker,
  schemaId,
  surfaceForWorker,
  SurfaceIdentityV1,
  UNKNOWN,
  type ClaimV1,
  type EvidencePacketV1,
  type FactV1,
  type InterventionActor,
  type InterventionType,
  type InterventionV1,
  type JudgmentV1,
  type ObservationV1,
} from "@ghostping/protocol"

type Row = Record<string, unknown>
type DbEffect<A> = Effect.Effect<A, SqlError>

const ts = (v: unknown): string => new Date(v instanceof Date ? v : String(v)).toISOString()
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex")

/** Hosted V1 questions are immutable, so the exact-prompt digest is the
 * question version. Shared by the worker and legacy export. */
export const hostedQuestionVersion = (prompt: string) => knownValue(`sha256:${sha256Hex(prompt)}`)

/** Measurement context the hosted worker records for each new observation. */
export const hostedMeasurementContext = (input: {
  readonly businessId: string
  readonly questionId: string
  readonly checkRunId: string
  readonly prompt: string
  readonly provider: string
  readonly requestedModel: string | null
  readonly observedModel: string | null
  readonly observedAt: string
}): MeasurementContextV1 => ({
  schema: schemaId.measurement,
  schema_version: 1,
  question: input.prompt,
  question_id: input.questionId,
  question_version: hostedQuestionVersion(input.prompt),
  business_id: input.businessId,
  surface: surfaceForWorker(input.provider, input.requestedModel, input.observedModel),
  observed_at: ts(input.observedAt),
  measurement_configuration: requestConfigurationForWorker(input.provider, input.requestedModel),
  sample_number: 1,
  repeat_id: knownValue(input.checkRunId),
})

export class EvidenceExportError extends Data.TaggedError("EvidenceExportError")<{
  readonly reason: string
  readonly detail: string
}> {}

export class InterventionCorrectionInvalid extends Data.TaggedError("InterventionCorrectionInvalid")<{
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// Interventions
// ---------------------------------------------------------------------------
export interface InterventionRow {
  readonly id: string
  readonly businessId: string
  readonly issueIds: ReadonlyArray<string>
  readonly type: InterventionType
  readonly target: string
  readonly performedAt: string
  readonly actor: InterventionActor
  readonly actorId: string | null
  readonly notes: string | null
  readonly evidenceBeforeDigest: string | null
  readonly evidenceAfterDigest: string | null
  readonly supersedesId: string | null
  readonly correctionReason: string | null
  readonly createdAt: string
}

export type InterventionInput = Omit<InterventionRow, "id" | "createdAt">

const mapIntervention = (r: Row, issueIds: ReadonlyArray<string>): InterventionRow => ({
  id: String(r["id"]),
  businessId: String(r["business_id"]),
  issueIds,
  type: String(r["type"]) as InterventionType,
  target: String(r["target"]),
  performedAt: ts(r["performed_at"]),
  actor: String(r["actor"]) as InterventionActor,
  actorId: str(r["actor_id"]),
  notes: str(r["notes"]),
  evidenceBeforeDigest: str(r["evidence_before_digest"]),
  evidenceAfterDigest: str(r["evidence_after_digest"]),
  supersedesId: str(r["supersedes_id"]),
  correctionReason: str(r["correction_reason"]),
  createdAt: ts(r["created_at"]),
})

export class InterventionRepository extends Context.Tag("InterventionRepository")<
  InterventionRepository,
  {
    /** Append-only. A correction is a new row with `supersedesId`; the
     * superseded row never changes. There is no update or delete method. */
    readonly append: (input: InterventionInput) => Effect.Effect<InterventionRow, SqlError | InterventionCorrectionInvalid>
    readonly listByIssue: (businessId: string, issueId: string) => DbEffect<ReadonlyArray<InterventionRow>>
  }
>() {}

const sortedIssueIds = (r: Row): ReadonlyArray<string> => ((r["issue_ids"] as Array<string> | null) ?? []).slice().sort()

export const InterventionRepositoryLive = Layer.effect(
  InterventionRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    append: (input) =>
      sql.withTransaction(
        Effect.gen(function*() {
          if (input.issueIds.length === 0) {
            return yield* Effect.fail(new InterventionCorrectionInvalid({ reason: "an intervention must reference at least one issue" }))
          }
          if ((input.supersedesId === null) !== (input.correctionReason === null)) {
            return yield* Effect.fail(new InterventionCorrectionInvalid({ reason: "a correction needs both supersedesId and correctionReason" }))
          }
          if (input.supersedesId !== null) {
            const prior = (yield* sql`
              SELECT array_agg(ii.issue_id::text) AS issue_ids FROM interventions i
              JOIN intervention_issues ii ON ii.intervention_id = i.id
              WHERE i.id = ${input.supersedesId} AND i.business_id = ${input.businessId}`) as Array<Row>
            const priorIssues = prior[0] ? sortedIssueIds(prior[0]) : []
            // A correction replaces the whole prior event, so it must cover
            // exactly the same issues; otherwise packets would lose lineage.
            if (priorIssues.length === 0 || priorIssues.join() !== [...input.issueIds].sort().join()) {
              return yield* Effect.fail(new InterventionCorrectionInvalid({ reason: "a correction must reference the superseded intervention's issues" }))
            }
          }
          const rows = (yield* sql`
            INSERT INTO interventions (business_id, type, target, performed_at, actor, actor_id, notes, evidence_before_digest, evidence_after_digest, supersedes_id, correction_reason)
            VALUES (${input.businessId}, ${input.type}, ${input.target}, ${input.performedAt}::timestamptz, ${input.actor}, ${input.actorId}, ${input.notes}, ${input.evidenceBeforeDigest}, ${input.evidenceAfterDigest}, ${input.supersedesId}, ${input.correctionReason})
            RETURNING *`) as Array<Row>
          const row = rows[0] as Row
          for (const issueId of input.issueIds) {
            yield* sql`INSERT INTO intervention_issues (intervention_id, issue_id) VALUES (${String(row["id"])}, ${issueId})`
          }
          return mapIntervention(row, [...input.issueIds].sort())
        }),
      ),
    listByIssue: (businessId, issueId) =>
      sql`
        SELECT i.*, (SELECT array_agg(all_ii.issue_id::text) FROM intervention_issues all_ii WHERE all_ii.intervention_id = i.id) AS issue_ids
        FROM interventions i JOIN intervention_issues ii ON ii.intervention_id = i.id
        WHERE i.business_id = ${businessId} AND ii.issue_id = ${issueId}
        ORDER BY i.performed_at, i.created_at, i.id`.pipe(
        Effect.map((rows) => (rows as Array<Row>).map((r) => mapIntervention(r, sortedIssueIds(r)))),
      ),
  })),
)

// ---------------------------------------------------------------------------
// Re-observation links (pure lineage; comparison is derived at export)
// ---------------------------------------------------------------------------
export interface ReobservationRow {
  readonly id: string
  readonly businessId: string
  readonly originalObservationId: string
  readonly issueId: string
  readonly interventionId: string | null
  readonly observationId: string
  readonly createdAt: string
}

const mapReobservation = (r: Row): ReobservationRow => ({
  id: String(r["id"]),
  businessId: String(r["business_id"]),
  originalObservationId: String(r["original_observation_id"]),
  issueId: String(r["issue_id"]),
  interventionId: str(r["intervention_id"]),
  observationId: String(r["observation_id"]),
  createdAt: ts(r["created_at"]),
})

export class ReobservationRepository extends Context.Tag("ReobservationRepository")<
  ReobservationRepository,
  {
    /** Append-only. The database rejects cross-tenant links, links whose
     * issue is not a claim on the original observation, and "later"
     * observations collected before the original. */
    readonly append: (input: Omit<ReobservationRow, "id" | "createdAt">) => DbEffect<ReobservationRow>
    readonly listByIssue: (businessId: string, issueId: string) => DbEffect<ReadonlyArray<ReobservationRow>>
  }
>() {}

export const ReobservationRepositoryLive = Layer.effect(
  ReobservationRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    append: (input) =>
      sql`
        INSERT INTO reobservations (business_id, original_observation_id, issue_id, intervention_id, observation_id)
        VALUES (${input.businessId}, ${input.originalObservationId}, ${input.issueId}, ${input.interventionId}, ${input.observationId})
        RETURNING *`.pipe(Effect.map((rows) => mapReobservation((rows as Array<Row>)[0] as Row))),
    listByIssue: (businessId, issueId) =>
      sql`SELECT * FROM reobservations WHERE business_id = ${businessId} AND issue_id = ${issueId} ORDER BY created_at, id`.pipe(
        Effect.map((rows) => (rows as Array<Row>).map(mapReobservation)),
      ),
  })),
)

// ---------------------------------------------------------------------------
// Complete issue lineage (tenant-scoped, one consistent snapshot)
// ---------------------------------------------------------------------------
export interface IssueLineage {
  readonly business: { readonly id: string; readonly name: string }
  readonly claim: Row
  readonly observations: ReadonlyArray<Row>
  readonly citations: ReadonlyArray<Row>
  readonly claims: ReadonlyArray<Row>
  readonly judgments: ReadonlyArray<Row>
  readonly facts: ReadonlyArray<Row>
  readonly interventions: ReadonlyArray<InterventionRow>
  readonly reobservations: ReadonlyArray<ReobservationRow>
}

export class EvidenceLineageRepository extends Context.Tag("EvidenceLineageRepository")<
  EvidenceLineageRepository,
  {
    /** Everything stored about one issue (= candidate claim id). Returns
     * null unless the issue belongs to `businessId` owned by `accountId`. */
    readonly loadIssue: (accountId: string, businessId: string, issueId: string) => DbEffect<IssueLineage | null>
  }
>() {}

export const EvidenceLineageRepositoryLive = Layer.effect(
  EvidenceLineageRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    loadIssue: (accountId, businessId, issueId) =>
      sql.withTransaction(
        Effect.gen(function*() {
          // One snapshot for the whole packet: concurrent appends cannot
          // produce a lineage that never existed at a single instant.
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
          const scoped = (yield* sql`
            SELECT c.*, b.name AS business_name FROM candidate_claims c
            JOIN businesses b ON b.id = c.business_id
            WHERE c.id = ${issueId} AND c.business_id = ${businessId} AND b.account_id = ${accountId}`) as Array<Row>
          const claim = scoped[0]
          if (!claim) return null
          const originalId = String(claim["observation_id"])
          const reobservations = (yield* sql`
            SELECT * FROM reobservations WHERE business_id = ${businessId} AND issue_id = ${issueId} ORDER BY created_at, id`) as Array<Row>
          const observationIds = [originalId, ...reobservations.map((r) => String(r["observation_id"]))]
          const observations = (yield* sql`
            SELECT o.*, cr.question_id, q.prompt AS question_prompt,
                   raw.digest AS raw_digest_sha256, raw.content_type AS raw_content_type, raw.raw_bytes_hex,
                   raw.received_at AS raw_received_at, raw.created_at AS raw_created_at, raw.provider_metadata
            FROM observations o
            JOIN raw_evidence raw ON raw.id = o.raw_evidence_id
            JOIN check_runs cr ON cr.id = o.check_run_id
            JOIN buyer_questions q ON q.id = cr.question_id
            WHERE o.business_id = ${businessId} AND o.id IN ${sql.in(observationIds)}`) as Array<Row>
          const citations = (yield* sql`
            SELECT * FROM observation_citations WHERE observation_id IN ${sql.in(observationIds)}
            ORDER BY observation_id, position NULLS LAST, id`) as Array<Row>
          // The issue claim plus every claim made on a re-observation.
          const afterIds = observationIds.slice(1)
          const claims = (yield* sql`
            SELECT * FROM candidate_claims WHERE business_id = ${businessId}
              AND (id = ${issueId} OR observation_id IN ${sql.in(afterIds.length > 0 ? afterIds : [originalId])} AND observation_id <> ${originalId})
            ORDER BY created_at, id`) as Array<Row>
          const claimIds = claims.map((c) => String(c["id"]))
          const judgments = (yield* sql`
            SELECT j.*, COALESCE(array_agg(jf.fact_id::text ORDER BY jf.fact_id::text) FILTER (WHERE jf.fact_id IS NOT NULL), '{}') AS fact_ids
            FROM human_judgments j LEFT JOIN human_judgment_facts jf ON jf.judgment_id = j.id
            WHERE j.business_id = ${businessId} AND j.claim_id IN ${sql.in(claimIds)}
            GROUP BY j.id ORDER BY j.created_at, j.id`) as Array<Row>
          // Referenced authority versions plus their supersession ancestors,
          // so historical versions are never dropped from a packet.
          const facts = (yield* sql`
            WITH RECURSIVE chain AS (
              SELECT f.* FROM authoritative_facts f
              WHERE f.business_id = ${businessId} AND f.id IN (
                SELECT jf.fact_id FROM human_judgment_facts jf JOIN human_judgments j ON j.id = jf.judgment_id
                WHERE j.business_id = ${businessId} AND j.claim_id IN ${sql.in(claimIds)})
              UNION
              SELECT p.* FROM authoritative_facts p JOIN chain ON chain.supersedes_id = p.id
              WHERE p.business_id = ${businessId}
            ) SELECT * FROM chain ORDER BY subject, predicate, version, id`) as Array<Row>
          const interventions = (yield* sql`
            SELECT i.*, (SELECT array_agg(all_ii.issue_id::text) FROM intervention_issues all_ii WHERE all_ii.intervention_id = i.id) AS issue_ids
            FROM interventions i JOIN intervention_issues ii ON ii.intervention_id = i.id
            WHERE i.business_id = ${businessId} AND ii.issue_id = ${issueId}
            ORDER BY i.performed_at, i.created_at, i.id`) as Array<Row>
          return {
            business: { id: businessId, name: String(claim["business_name"]) },
            claim,
            observations,
            citations,
            claims,
            judgments,
            facts,
            interventions: interventions.map((r) => mapIntervention(r, sortedIssueIds(r))),
            reobservations: reobservations.map(mapReobservation),
          }
        }),
      ),
  })),
)

// ---------------------------------------------------------------------------
// Export: stored lineage → EvidencePacketV1 (derivation lives in protocol)
// ---------------------------------------------------------------------------
const decodeMeasurement = Schema.decodeUnknownEither(MeasurementContextV1)
const decodeSurface = Schema.decodeUnknownEither(SurfaceIdentityV1)

const toObservation = (row: Row, citations: ReadonlyArray<Row>, embed: boolean): Effect.Effect<ObservationV1, EvidenceExportError> =>
  Effect.gen(function*() {
    const id = String(row["id"])
    const fail = (reason: string, detail = id) => Effect.fail(new EvidenceExportError({ reason, detail }))
    const provider = String(row["provider"])
    let measurement: MeasurementContextV1
    if (row["measurement_context"] != null) {
      const decoded = decodeMeasurement(row["measurement_context"])
      if (decoded._tag === "Left") return yield* fail("StoredMeasurementContextInvalid")
      measurement = decoded.right
    } else {
      // Pre-protocol observation: rebuild only from stored columns. The
      // question prompt is immutable in Hosted V1; the request configuration
      // was never recorded, so it stays UNKNOWN.
      let surface: SurfaceIdentityV1
      if (row["surface_identity"] != null) {
        const decoded = decodeSurface(row["surface_identity"])
        if (decoded._tag === "Left") return yield* fail("StoredSurfaceIdentityInvalid")
        surface = decoded.right
      } else {
        try {
          surface = surfaceForWorker(provider, str(row["requested_model"]), str(row["observed_model"]))
        } catch {
          return yield* fail("UnsupportedLegacyProvider", provider)
        }
      }
      const prompt = String(row["question_prompt"])
      measurement = {
        schema: schemaId.measurement,
        schema_version: 1,
        question: prompt,
        question_id: String(row["question_id"]),
        question_version: hostedQuestionVersion(prompt),
        business_id: String(row["business_id"]),
        surface,
        observed_at: ts(row["collected_at"]),
        measurement_configuration: UNKNOWN,
        sample_number: 1,
        repeat_id: knownValue(String(row["check_run_id"])),
      }
    }
    const digest = String(row["raw_digest_sha256"])
    const bytesHex = str(row["raw_bytes_hex"])
    if (embed && bytesHex === null) return yield* fail("RawBytesUnavailable")
    const metadata = row["provider_metadata"]
    return {
      schema: schemaId.observation,
      schema_version: 1,
      id,
      business_id: String(row["business_id"]),
      measurement,
      raw_evidence: {
        id: String(row["raw_evidence_id"]),
        digest_sha256: digest,
        content_type: String(row["raw_content_type"]),
        received_at: ts(row["raw_received_at"] ?? row["raw_created_at"]),
        reference: `ghostping://raw-evidence/${digest}`,
        ...(embed && bytesHex !== null ? { embedded_bytes_base64: Buffer.from(bytesHex, "hex").toString("base64") } : {}),
      },
      normalized_answer_text: String(row["answer_text"]),
      citations: citations
        .filter((c) => String(c["observation_id"]) === id)
        .map((c) => ({
          uri: str(c["uri"]),
          title: str(c["title"]),
          position: c["position"] === null ? null : Number(c["position"]),
          attributed: Boolean(c["attributed"]),
        })),
      provider_metadata: metadata === null || metadata === undefined ? UNKNOWN : knownValue(metadata),
      // The mock provider is synthetic by definition, including rows stored
      // before the `synthetic` column existed.
      synthetic: Boolean(row["synthetic"]) || provider === "mock" || measurement.surface.kind === "MOCK",
      created_at: ts(row["created_at"]),
    }
  })

const toClaim = (r: Row): ClaimV1 => ({
  schema: schemaId.claim,
  schema_version: 1,
  id: String(r["id"]),
  business_id: String(r["business_id"]),
  observation_id: String(r["observation_id"]),
  text: String(r["text"]),
  origin: String(r["origin"]) as ClaimV1["origin"],
  created_at: ts(r["created_at"]),
})

const toJudgment = (r: Row): JudgmentV1 => ({
  schema: schemaId.judgment,
  schema_version: 1,
  id: String(r["id"]),
  business_id: String(r["business_id"]),
  claim_id: String(r["claim_id"]),
  verdict: String(r["verdict"]) as JudgmentV1["verdict"],
  notes: str(r["notes"]),
  fact_ids: (r["fact_ids"] as Array<string> | null) ?? [],
  supersedes_id: str(r["supersedes_id"]),
  created_at: ts(r["created_at"]),
})

const toFact = (r: Row): FactV1 => ({
  schema: schemaId.fact,
  schema_version: 1,
  id: String(r["id"]),
  business_id: String(r["business_id"]),
  subject: String(r["subject"]),
  predicate: String(r["predicate"]),
  value_text: String(r["value_text"]),
  value_type: String(r["value_type"]),
  // Current lifecycle status; temporal applicability is valid_from/until.
  status: String(r["status"]) as FactV1["status"],
  version: Number(r["version"]),
  supersedes_id: str(r["supersedes_id"]),
  valid_from: ts(r["valid_from"]),
  valid_until: r["valid_until"] == null ? null : ts(r["valid_until"]),
  source_kind: String(r["source_kind"]),
  created_at: ts(r["created_at"]),
})

const toIntervention = (i: InterventionRow): InterventionV1 => ({
  schema: schemaId.intervention,
  schema_version: 1,
  id: i.id,
  business_id: i.businessId,
  issue_ids: i.issueIds,
  type: i.type,
  target: i.target,
  performed_at: i.performedAt,
  actor: i.actor,
  actor_id: i.actorId === null ? UNKNOWN : knownValue(i.actorId),
  notes: i.notes,
  evidence_before_digest: i.evidenceBeforeDigest === null ? UNKNOWN : knownValue(i.evidenceBeforeDigest),
  evidence_after_digest: i.evidenceAfterDigest === null ? UNKNOWN : knownValue(i.evidenceAfterDigest),
  supersedes_id: i.supersedesId,
  correction_reason: i.correctionReason,
  created_at: i.createdAt,
})

/** Deterministic export of one issue lineage. Identical stored state and
 * `generatedAt` always yield identical packet bytes and digest. */
export const exportIssuePacket = (input: {
  readonly accountId: string
  readonly businessId: string
  readonly issueId: string
  readonly generatedAt: string
  readonly embedRawEvidence?: boolean
}): Effect.Effect<EvidencePacketV1 | null, SqlError | EvidenceExportError, EvidenceLineageRepository> =>
  Effect.gen(function*() {
    const repo = yield* EvidenceLineageRepository
    const lineage = yield* repo.loadIssue(input.accountId, input.businessId, input.issueId)
    if (lineage === null) return null
    const embed = input.embedRawEvidence === true
    const byId = new Map<string, ObservationV1>()
    for (const row of lineage.observations) {
      byId.set(String(row["id"]), yield* toObservation(row, lineage.citations, embed))
    }
    const original = byId.get(String(lineage.claim["observation_id"]))
    if (!original) return yield* Effect.fail(new EvidenceExportError({ reason: "OriginalObservationMissing", detail: input.issueId }))
    const claims = lineage.claims.map(toClaim)
    const judgments = lineage.judgments.map(toJudgment)
    const ownJudgments = (claimIds: ReadonlySet<string>) => judgments.filter((j) => claimIds.has(j.claim_id))
    try {
      // Validate our own output: stored data that cannot form a valid V1
      // packet fails closed instead of being exported.
      return validatePacket(exportEvidencePacket({
        id: `evidence-packet:${input.issueId}`,
        business: lineage.business,
        issue: { id: input.issueId, type: UNKNOWN, created_at: ts(lineage.claim["created_at"]) },
        issue_claim_id: input.issueId,
        facts: lineage.facts.map(toFact),
        original_observation: original,
        claims: claims.filter((c) => c.id === input.issueId),
        judgments: ownJudgments(new Set([input.issueId])),
        interventions: lineage.interventions.map(toIntervention),
        reobservations: lineage.reobservations.map((r) => {
          const after = byId.get(r.observationId) as ObservationV1
          const afterClaims = claims.filter((c) => c.observation_id === r.observationId)
          return {
            id: r.id,
            intervention_id: r.interventionId,
            created_at: r.createdAt,
            observation: after,
            claims: afterClaims,
            judgments: ownJudgments(new Set(afterClaims.map((c) => c.id))),
          }
        }),
        generated_at: ts(input.generatedAt),
      }))
    } catch (e) {
      return yield* Effect.fail(new EvidenceExportError({ reason: "PacketAssemblyFailed", detail: e instanceof Error ? e.message : String(e) }))
    }
  })
