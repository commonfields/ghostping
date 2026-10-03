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

export class ProductReadRepository extends Context.Tag("ProductReadRepository")<
  ProductReadRepository,
  {
    readonly authorityMode: (businessId: string) => Effect.Effect<string | null, unknown>
    readonly factProvenance: (businessId: string) => Effect.Effect<ReadonlyArray<Record<string, string | null>>, unknown>
    readonly factHistory: (businessId: string, subject: string, predicate: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
    readonly targets: (businessId: string) => Effect.Effect<ReadonlyArray<ReturnType<typeof mapTarget>>, unknown>
    readonly bindings: (businessId: string) => Effect.Effect<ReadonlyArray<ReturnType<typeof mapBinding>>, unknown>
    readonly binding: (businessId: string, bindingId: string) => Effect.Effect<ReturnType<typeof mapBinding> | null, unknown>
    readonly observations: (businessId: string) => Effect.Effect<ReadonlyArray<ReturnType<typeof mapSourceObservation>>, unknown>
    readonly values: (businessId: string) => Effect.Effect<ReadonlyArray<ReturnType<typeof mapSourceValue>>, unknown>
    readonly aiCitations: (businessId: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
    readonly createBinding: (input: { businessId: string; factId: string; sourceTargetId: string; extractorKind: string; extractorSelector: string; comparator: string }) => Effect.Effect<ReturnType<typeof mapBinding>, unknown>
    readonly findBindingExact: (businessId: string, targetId: string, factId: string, kind: string, selector: string, comparator: string) => Effect.Effect<ReturnType<typeof mapBinding> | null, unknown>
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
        return rows.map((r) => ({
          factId: String(r["fact_id"]),
          manifestKey: String(r["manifest_key"]),
          manifestDigest: String(r["manifest_digest"]),
          sourceRevision: (r["source_revision"] as string | null) ?? null,
          syncedAt: iso(r["synced_at"]),
          sourceUrl: (r["source_url"] as string | null) ?? null,
        }))
      }),
    factHistory: (businessId: string, subject: string, predicate: string) =>
      Effect.gen(function*() {
        return (yield* sql`SELECT * FROM authoritative_facts WHERE business_id = ${businessId} AND subject = ${subject} AND predicate = ${predicate} ORDER BY version ASC`) as Array<Record<string, unknown>>
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
          SELECT c.uri, c.title, c.position, c.attributed, o.id AS observation_id, o.provider, o.observed_model, o.collected_at, cl.id AS claim_id, cl.text AS claim_text
          FROM observation_citations c
          JOIN observations o ON o.id = c.observation_id
          LEFT JOIN candidate_claims cl ON cl.observation_id = o.id
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
  })),
)
