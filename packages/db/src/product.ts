// Product Surface V1 read repositories (Effect, PostgreSQL).
// Tenant scoping rule: every query filters by business_id; API routes
// additionally scope the business to the session account (getScoped) and
// treat anything else as 404, never leaking cross-account existence.
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer, Schema } from "effect"
import {
  BooleanField,
  NullableIntField,
  NullableTextField,
  TextField,
  TimestampField,
  UuidField,
  decodeRow,
} from "./row-codecs.js"
import type { SourceTargetRow } from "./representation.js"

const iso = (v: Date | string): string => new Date(String(v)).toISOString()

const SourceTargetSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  url: TextField,
  control: TextField,
  enabled: BooleanField,
  created_at: TimestampField,
})

const decodeTarget = (r: unknown) =>
  decodeRow(SourceTargetSchema, "source_targets", r).pipe(
    Effect.map((d): SourceTargetRow => ({
      id: d.id,
      businessId: d.business_id,
      url: d.url,
      control: d.control,
      enabled: d.enabled,
      createdAt: iso(d.created_at),
    })),
  )

const SourceBindingSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  fact_id: UuidField,
  source_target_id: UuidField,
  extractor_kind: TextField,
  extractor_selector: TextField,
  comparator: TextField,
  created_at: TimestampField,
})

export interface SourceBindingRow {
  readonly id: string
  readonly businessId: string
  readonly factId: string
  readonly sourceTargetId: string
  readonly extractorKind: string
  readonly extractorSelector: string
  readonly comparator: string
  readonly createdAt: string
}

const decodeBinding = (r: unknown) =>
  decodeRow(SourceBindingSchema, "source_bindings", r).pipe(
    Effect.map((d): SourceBindingRow => ({
      id: d.id,
      businessId: d.business_id,
      factId: d.fact_id,
      sourceTargetId: d.source_target_id,
      extractorKind: d.extractor_kind,
      extractorSelector: d.extractor_selector,
      comparator: d.comparator,
      createdAt: iso(d.created_at),
    })),
  )

const SourceObservationSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  source_target_id: UuidField,
  collector: TextField,
  collector_version: TextField,
  requested_url: TextField,
  final_url: TextField,
  started_at: TimestampField,
  completed_at: TimestampField,
  http_status: NullableIntField,
  content_type: NullableTextField,
  etag: NullableTextField,
  last_modified: NullableTextField,
  body_digest: NullableTextField,
  body_bytes: NullableIntField,
  collection_state: TextField,
  failure: NullableTextField,
})

export interface SourceObservationRow {
  readonly id: string
  readonly businessId: string
  readonly sourceTargetId: string
  readonly collector: string
  readonly collectorVersion: string
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly startedAt: string
  readonly completedAt: string
  readonly httpStatus: number | null
  readonly contentType: string | null
  readonly etag: string | null
  readonly lastModified: string | null
  readonly bodyDigest: string | null
  readonly bodyBytes: number
  readonly collectionState: string
  readonly failure: string | null
}

const decodeSourceObservation = (r: unknown) =>
  decodeRow(SourceObservationSchema, "source_observations", r).pipe(
    Effect.map((d): SourceObservationRow => ({
      id: d.id,
      businessId: d.business_id,
      sourceTargetId: d.source_target_id,
      collector: d.collector,
      collectorVersion: d.collector_version,
      requestedUrl: d.requested_url,
      finalUrl: d.final_url,
      startedAt: iso(d.started_at),
      completedAt: iso(d.completed_at),
      httpStatus: d.http_status === null ? null : Number(d.http_status),
      contentType: d.content_type,
      etag: d.etag,
      lastModified: d.last_modified,
      bodyDigest: d.body_digest,
      bodyBytes: Number(d.body_bytes ?? 0),
      collectionState: d.collection_state,
      failure: d.failure,
    })),
  )

const SourceValueSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  source_observation_id: UuidField,
  source_binding_id: UuidField,
  fact_id: UuidField,
  extracted_value: NullableTextField,
  extraction_state: TextField,
  evidence_selector: TextField,
  evidence_observation_id: UuidField,
  evidence_node_identity: NullableTextField,
  extractor_version: TextField,
  created_at: TimestampField,
})

export interface SourceValueRow {
  readonly id: string
  readonly businessId: string
  readonly sourceObservationId: string
  readonly sourceBindingId: string
  readonly factId: string
  readonly extractedValue: string | null
  readonly extractionState: string
  readonly evidenceSelector: string
  readonly evidenceObservationId: string
  readonly evidenceNodeIdentity: string | null
  readonly extractorVersion: string
  readonly createdAt: string
}

const decodeSourceValue = (r: unknown) =>
  decodeRow(SourceValueSchema, "observed_source_values", r).pipe(
    Effect.map((d): SourceValueRow => ({
      id: d.id,
      businessId: d.business_id,
      sourceObservationId: d.source_observation_id,
      sourceBindingId: d.source_binding_id,
      factId: d.fact_id,
      extractedValue: d.extracted_value,
      extractionState: d.extraction_state,
      evidenceSelector: d.evidence_selector,
      evidenceObservationId: d.evidence_observation_id,
      evidenceNodeIdentity: d.evidence_node_identity,
      extractorVersion: d.extractor_version,
      createdAt: iso(d.created_at),
    })),
  )

const FactProvenanceSchema = Schema.Struct({
  fact_id: UuidField,
  manifest_key: TextField,
  manifest_digest: TextField,
  source_revision: NullableTextField,
  synced_at: TimestampField,
  source_url: NullableTextField,
})

export interface FactProvenanceRow {
  readonly factId: string
  readonly manifestKey: string
  readonly manifestDigest: string
  readonly sourceRevision: string | null
  readonly syncedAt: string
  readonly sourceUrl: string | null
}

export class ProductReadRepository extends Context.Tag("ProductReadRepository")<
  ProductReadRepository,
  {
    readonly authorityMode: (businessId: string) => Effect.Effect<string | null, unknown>
    readonly factProvenance: (businessId: string) => Effect.Effect<ReadonlyArray<FactProvenanceRow>, unknown>
    readonly factHistory: (businessId: string, subject: string, predicate: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
    /**
     * Full authority lineage for one fact version: walks supersedes_id up
     * to the root and down to every descendant, ordered by version.
     * Cycle-safe (visited path + depth cap). Linearity itself is checked
     * by the caller (fail closed on forks).
     */
    readonly factLineage: (businessId: string, factId: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
    readonly targets: (businessId: string) => Effect.Effect<ReadonlyArray<SourceTargetRow>, unknown>
    readonly bindings: (businessId: string) => Effect.Effect<ReadonlyArray<SourceBindingRow>, unknown>
    readonly binding: (businessId: string, bindingId: string) => Effect.Effect<SourceBindingRow | null, unknown>
    readonly observations: (businessId: string) => Effect.Effect<ReadonlyArray<SourceObservationRow>, unknown>
    readonly values: (businessId: string) => Effect.Effect<ReadonlyArray<SourceValueRow>, unknown>
    readonly aiCitations: (businessId: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
    readonly createBinding: (input: { businessId: string; factId: string; sourceTargetId: string; extractorKind: string; extractorSelector: string; comparator: string }) => Effect.Effect<SourceBindingRow, unknown>
    readonly findBindingExact: (businessId: string, targetId: string, factId: string, kind: string, selector: string, comparator: string) => Effect.Effect<SourceBindingRow | null, unknown>
    /**
     * Issue inbox rows for one business (RESOLVED filtered by the caller).
     * Linked facts carry their own immutable version — a judgment linked to
     * v1 must render v1 even after authority advances to v3.
     */
    readonly issueList: (businessId: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
    readonly issueDetailRow: (businessId: string, claimId: string) => Effect.Effect<Record<string, unknown> | null, unknown>
  }
>() {}

export const ProductReadRepositoryLive = Layer.effect(
  ProductReadRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    authorityMode: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT writer FROM business_authority_mode WHERE business_id = ${businessId}`) as Array<Record<string, unknown>>
        const w = rows[0]?.["writer"]
        return (typeof w === "string" ? w : null) as string | null
      }),
    factProvenance: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT fact_id, manifest_key, manifest_digest, source_revision, synced_at, source_url FROM repository_fact_provenance WHERE business_id = ${businessId}`) as Array<unknown>
        return yield* Effect.forEach(rows, (r) =>
          decodeRow(FactProvenanceSchema, "repository_fact_provenance", r).pipe(
            Effect.map(
              (d): FactProvenanceRow => ({
                factId: d.fact_id,
                manifestKey: d.manifest_key,
                manifestDigest: d.manifest_digest,
                sourceRevision: d.source_revision,
                syncedAt: iso(d.synced_at),
                sourceUrl: d.source_url,
              }),
            ),
          ),
        )
      }),
    factHistory: (businessId: string, subject: string, predicate: string) =>
      Effect.gen(function*() {
        return (yield* sql`SELECT * FROM authoritative_facts WHERE business_id = ${businessId} AND subject = ${subject} AND predicate = ${predicate} ORDER BY version ASC`) as Array<Record<string, unknown>>
      }),
    factLineage: (businessId: string, factId: string) =>
      Effect.gen(function*() {
        // Root-first full-component traversal: walk supersedes_id upward to
        // the lineage root, then every descendant below it. A query from ANY
        // version (or a forked sibling) returns the same connected
        // component, so assertLinearLineage rejects forks regardless of the
        // requested starting version. Cycle-safe via visited paths + depth.
        return (yield* sql`
          WITH RECURSIVE
          up(id, sup, depth, path) AS (
            SELECT id, supersedes_id, 1, ARRAY[id] FROM authoritative_facts WHERE id = ${factId} AND business_id = ${businessId}
            UNION ALL
            SELECT f.id, f.supersedes_id, u.depth + 1, u.path || f.id FROM authoritative_facts f
            JOIN up u ON f.id = u.sup
            WHERE f.business_id = ${businessId} AND NOT f.id = ANY (u.path) AND u.depth < 1000
          ),
          roots(id) AS (
            SELECT id FROM up WHERE sup IS NULL
          ),
          down(id, depth, path) AS (
            SELECT id, 1, ARRAY[id] FROM up WHERE id IN (SELECT id FROM roots)
            UNION ALL
            SELECT f.id, d.depth + 1, d.path || f.id FROM authoritative_facts f
            JOIN down d ON f.supersedes_id = d.id
            WHERE f.business_id = ${businessId} AND NOT f.id = ANY (d.path) AND d.depth < 1000
          )
          SELECT DISTINCT f.* FROM authoritative_facts f
          WHERE f.business_id = ${businessId} AND (f.id IN (SELECT id FROM up) OR f.id IN (SELECT id FROM down))
          ORDER BY f.version ASC`) as Array<Record<string, unknown>>
      }),
    targets: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_targets WHERE business_id = ${businessId} ORDER BY created_at ASC`) as Array<unknown>
        return yield* Effect.forEach(rows, decodeTarget)
      }),
    bindings: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_bindings WHERE business_id = ${businessId} ORDER BY created_at ASC`) as Array<unknown>
        return yield* Effect.forEach(rows, decodeBinding)
      }),
    binding: (businessId: string, bindingId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_bindings WHERE id = ${bindingId} AND business_id = ${businessId}`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeBinding(r)
      }),
    observations: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_observations WHERE business_id = ${businessId} ORDER BY completed_at ASC`) as Array<unknown>
        return yield* Effect.forEach(rows, decodeSourceObservation)
      }),
    values: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM observed_source_values WHERE business_id = ${businessId} ORDER BY created_at ASC`) as Array<unknown>
        return yield* Effect.forEach(rows, decodeSourceValue)
      }),
    aiCitations: (businessId: string) =>
      Effect.gen(function*() {
        // Provider-returned citations with their observation context, scoped
        // to this business. Canonical matching happens in the API layer.
        return (yield* sql`
          SELECT c.uri, c.title, c.position, c.attributed, o.id AS observation_id, o.provider, o.observed_model, o.collected_at
          FROM observation_citations c
          JOIN observations o ON o.id = c.observation_id
          WHERE o.business_id = ${businessId}
          ORDER BY o.collected_at ASC`) as Array<Record<string, unknown>>
      }),
    createBinding: (input) =>
      Effect.gen(function*() {
        const rows = (yield* sql`INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator) VALUES (${input.businessId}, ${input.factId}, ${input.sourceTargetId}, ${input.extractorKind}, ${input.extractorSelector}, ${input.comparator}) RETURNING *`) as Array<unknown>
        return yield* decodeBinding(rows[0])
      }),
    findBindingExact: (businessId, targetId, factId, kind, selector, comparator) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_bindings WHERE business_id = ${businessId} AND source_target_id = ${targetId} AND fact_id = ${factId} AND extractor_kind = ${kind} AND extractor_selector = ${selector} AND comparator = ${comparator} LIMIT 1`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeBinding(r)
      }),
    issueList: (businessId: string) =>
      Effect.gen(function*() {
        return (yield* sql`
          SELECT c.id AS claim_id, c.text AS claim_text, c.observation_id, o.answer_text, o.provider, o.observed_model, o.collected_at,
                 q.prompt AS question_prompt,
                 j.id AS judgment_id, j.verdict, j.notes,
                 COALESCE((SELECT json_agg(json_build_object('id', f.id, 'predicate', f.predicate, 'valueText', f.value_text, 'status', f.status, 'version', f.version) ORDER BY f.predicate)
                   FROM human_judgment_facts hjf JOIN authoritative_facts f ON f.id = hjf.fact_id WHERE hjf.judgment_id = j.id), '[]'::json) AS facts
          FROM candidate_claims c
          JOIN observations o ON o.id = c.observation_id
          LEFT JOIN check_runs cr ON cr.id = o.check_run_id
          LEFT JOIN buyer_questions q ON q.id = cr.question_id
          LEFT JOIN human_judgments j ON j.claim_id = c.id AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id)
          WHERE c.business_id = ${businessId} ORDER BY c.created_at DESC`) as Array<Record<string, unknown>>
      }),
    issueDetailRow: (businessId: string, claimId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`
          SELECT c.id AS claim_id, c.text AS claim_text, c.observation_id, o.answer_text, o.provider, o.observed_model, o.collected_at,
                 q.prompt AS question_prompt,
                 j.id AS judgment_id, j.verdict, j.notes,
                 COALESCE((SELECT json_agg(json_build_object('id', f.id, 'predicate', f.predicate, 'valueText', f.value_text, 'status', f.status, 'version', f.version) ORDER BY f.predicate)
                   FROM human_judgment_facts hjf JOIN authoritative_facts f ON f.id = hjf.fact_id WHERE hjf.judgment_id = j.id), '[]'::json) AS facts
          FROM candidate_claims c
          JOIN observations o ON o.id = c.observation_id
          LEFT JOIN check_runs cr ON cr.id = o.check_run_id
          LEFT JOIN buyer_questions q ON q.id = cr.question_id
          LEFT JOIN human_judgments j ON j.claim_id = c.id AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id)
          WHERE c.business_id = ${businessId} AND c.id = ${claimId}`) as Array<Record<string, unknown>>
        return (rows[0] ?? null) as Record<string, unknown> | null
      }),
  })),
)
