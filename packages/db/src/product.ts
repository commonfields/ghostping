// Product Surface V1 read repositories (Effect, PostgreSQL).
// Tenant scoping rule: every query filters by business_id; API routes
// additionally scope the business to the session account (getScoped) and
// treat anything else as 404, never leaking cross-account existence.
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer } from "effect"

const iso = (v: unknown): string => new Date(String(v)).toISOString()

const mapTarget = (r: Record<string, unknown>) => ({
  id: String(r["id"]),
  businessId: String(r["business_id"]),
  url: String(r["url"]),
  control: String(r["control"]),
  enabled: Boolean(r["enabled"]),
  createdAt: iso(r["created_at"]),
})

const mapBinding = (r: Record<string, unknown>) => ({
  id: String(r["id"]),
  businessId: String(r["business_id"]),
  factId: String(r["fact_id"]),
  sourceTargetId: String(r["source_target_id"]),
  extractorKind: String(r["extractor_kind"]),
  extractorSelector: String(r["extractor_selector"]),
  comparator: String(r["comparator"]),
  createdAt: iso(r["created_at"]),
})

const mapSourceObservation = (r: Record<string, unknown>) => ({
  id: String(r["id"]),
  businessId: String(r["business_id"]),
  sourceTargetId: String(r["source_target_id"]),
  collector: String(r["collector"]),
  collectorVersion: String(r["collector_version"]),
  requestedUrl: String(r["requested_url"]),
  finalUrl: String(r["final_url"]),
  startedAt: iso(r["started_at"]),
  completedAt: iso(r["completed_at"]),
  httpStatus: r["http_status"] === null ? null : Number(r["http_status"]),
  contentType: (r["content_type"] as string | null) ?? null,
  etag: (r["etag"] as string | null) ?? null,
  lastModified: (r["last_modified"] as string | null) ?? null,
  bodyDigest: (r["body_digest"] as string | null) ?? null,
  bodyBytes: Number(r["body_bytes"] ?? 0),
  collectionState: String(r["collection_state"]),
  failure: (r["failure"] as string | null) ?? null,
})

const mapSourceValue = (r: Record<string, unknown>) => ({
  id: String(r["id"]),
  businessId: String(r["business_id"]),
  sourceObservationId: String(r["source_observation_id"]),
  sourceBindingId: String(r["source_binding_id"]),
  factId: String(r["fact_id"]),
  extractedValue: (r["extracted_value"] as string | null) ?? null,
  extractionState: String(r["extraction_state"]),
  evidenceSelector: String(r["evidence_selector"]),
  evidenceObservationId: String(r["evidence_observation_id"]),
  evidenceNodeIdentity: (r["evidence_node_identity"] as string | null) ?? null,
  extractorVersion: String(r["extractor_version"]),
  createdAt: iso(r["created_at"]),
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
    readonly targets: (businessId: string) => Effect.Effect<ReadonlyArray<ReturnType<typeof mapTarget>>, unknown>
    readonly bindings: (businessId: string) => Effect.Effect<ReadonlyArray<ReturnType<typeof mapBinding>>, unknown>
    readonly binding: (businessId: string, bindingId: string) => Effect.Effect<ReturnType<typeof mapBinding> | null, unknown>
    readonly observations: (businessId: string) => Effect.Effect<ReadonlyArray<ReturnType<typeof mapSourceObservation>>, unknown>
    readonly values: (businessId: string) => Effect.Effect<ReadonlyArray<ReturnType<typeof mapSourceValue>>, unknown>
    readonly aiCitations: (businessId: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
    readonly createBinding: (input: { businessId: string; factId: string; sourceTargetId: string; extractorKind: string; extractorSelector: string; comparator: string }) => Effect.Effect<ReturnType<typeof mapBinding>, unknown>
    readonly findBindingExact: (businessId: string, targetId: string, factId: string, kind: string, selector: string, comparator: string) => Effect.Effect<ReturnType<typeof mapBinding> | null, unknown>
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
        const rows = (yield* sql`SELECT fact_id, manifest_key, manifest_digest, source_revision, synced_at, source_url FROM repository_fact_provenance WHERE business_id = ${businessId}`) as Array<Record<string, unknown>>
        return rows.map(
          (r): FactProvenanceRow => ({
            factId: String(r["fact_id"]),
            manifestKey: String(r["manifest_key"]),
            manifestDigest: String(r["manifest_digest"]),
            sourceRevision: (r["source_revision"] as string | null) ?? null,
            syncedAt: iso(r["synced_at"]),
            sourceUrl: (r["source_url"] as string | null) ?? null,
          }),
        )
      }),
    factHistory: (businessId: string, subject: string, predicate: string) =>
      Effect.gen(function*() {
        return (yield* sql`SELECT * FROM authoritative_facts WHERE business_id = ${businessId} AND subject = ${subject} AND predicate = ${predicate} ORDER BY version ASC`) as Array<Record<string, unknown>>
      }),
    factLineage: (businessId: string, factId: string) =>
      Effect.gen(function*() {
        return (yield* sql`
          WITH RECURSIVE
          up(id, sup, depth, path) AS (
            SELECT id, supersedes_id, 1, ARRAY[id] FROM authoritative_facts WHERE id = ${factId} AND business_id = ${businessId}
            UNION ALL
            SELECT f.id, f.supersedes_id, u.depth + 1, u.path || f.id FROM authoritative_facts f
            JOIN up u ON f.id = u.sup
            WHERE f.business_id = ${businessId} AND NOT f.id = ANY (u.path) AND u.depth < 1000
          ),
          down(id, depth, path) AS (
            SELECT id, 1, ARRAY[id] FROM authoritative_facts WHERE id = ${factId} AND business_id = ${businessId}
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
        const rows = (yield* sql`SELECT * FROM source_targets WHERE business_id = ${businessId} ORDER BY created_at ASC`) as Array<Record<string, unknown>>
        return rows.map(mapTarget)
      }),
    bindings: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_bindings WHERE business_id = ${businessId} ORDER BY created_at ASC`) as Array<Record<string, unknown>>
        return rows.map(mapBinding)
      }),
    binding: (businessId: string, bindingId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_bindings WHERE id = ${bindingId} AND business_id = ${businessId}`) as Array<Record<string, unknown>>
        const r = rows[0]
        return r ? mapBinding(r) : null
      }),
    observations: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_observations WHERE business_id = ${businessId} ORDER BY completed_at ASC`) as Array<Record<string, unknown>>
        return rows.map(mapSourceObservation)
      }),
    values: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM observed_source_values WHERE business_id = ${businessId} ORDER BY created_at ASC`) as Array<Record<string, unknown>>
        return rows.map(mapSourceValue)
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
        const rows = (yield* sql`INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator) VALUES (${input.businessId}, ${input.factId}, ${input.sourceTargetId}, ${input.extractorKind}, ${input.extractorSelector}, ${input.comparator}) RETURNING *`) as Array<Record<string, unknown>>
        return mapBinding(rows[0]!)
      }),
    findBindingExact: (businessId, targetId, factId, kind, selector, comparator) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_bindings WHERE business_id = ${businessId} AND source_target_id = ${targetId} AND fact_id = ${factId} AND extractor_kind = ${kind} AND extractor_selector = ${selector} AND comparator = ${comparator} LIMIT 1`) as Array<Record<string, unknown>>
        const r = rows[0]
        return r ? mapBinding(r) : null
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
