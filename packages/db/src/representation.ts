// Representation Graph V1 persistence: targets/bindings (editable config),
// observations/values (append-only evidence). Findings are derived.
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer, Schema } from "effect"
import {
  BooleanField,
  TextField,
  TimestampField,
  UuidField,
  decodeRow,
} from "./row-codecs.js"

const iso = (v: Date | string): string => new Date(String(v)).toISOString()

const RepresentationTargetSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  url: TextField,
  control: TextField,
  enabled: BooleanField,
  created_at: TimestampField,
})

const decodeRepresentationTarget = (r: unknown) =>
  decodeRow(RepresentationTargetSchema, "source_targets", r).pipe(
    Effect.map(
      (d): SourceTargetRow => ({
        id: d.id,
        businessId: d.business_id,
        url: d.url,
        control: d.control,
        enabled: d.enabled,
        createdAt: iso(d.created_at),
      }),
    ),
  )

export interface SourceTargetRow {
  readonly id: string
  readonly businessId: string
  readonly url: string
  readonly control: string
  readonly enabled: boolean
  readonly createdAt: string
}

export class SourceTargetRepository extends Context.Tag("SourceTargetRepository")<
  SourceTargetRepository,
  {
    readonly create: (input: { businessId: string; url: string; control: string; enabled?: boolean }) => Effect.Effect<SourceTargetRow, unknown>
    readonly listByBusiness: (businessId: string) => Effect.Effect<ReadonlyArray<SourceTargetRow>, unknown>
  }
>() {}

export const SourceTargetRepositoryLive = Layer.effect(
  SourceTargetRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    create: (input) =>
      Effect.gen(function*() {
        const rows = (yield* sql`INSERT INTO source_targets (business_id, url, control, enabled) VALUES (${input.businessId}, ${input.url}, ${input.control}, ${input.enabled ?? true}) RETURNING *`) as Array<unknown>
        return yield* decodeRepresentationTarget(rows[0])
      }),
    listByBusiness: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_targets WHERE business_id = ${businessId} ORDER BY created_at ASC`) as Array<unknown>
        return yield* Effect.forEach(rows, decodeRepresentationTarget)
      }),
  })),
)

export class SourceObservationRepository extends Context.Tag("SourceObservationRepository")<
  SourceObservationRepository,
  {
    readonly create: (input: Record<string, string | number | boolean | null>) => Effect.Effect<Record<string, unknown>, unknown>
    readonly latestByTarget: (targetId: string) => Effect.Effect<Record<string, unknown> | null, unknown>
    readonly historyByTarget: (targetId: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
  }
>() {}

export const SourceObservationRepositoryLive = Layer.effect(
  SourceObservationRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    create: (input) =>
      Effect.gen(function*() {
        const rows = (yield* sql`INSERT INTO source_observations (business_id, source_target_id, collector, collector_version, requested_url, final_url, started_at, completed_at, http_status, content_type, etag, last_modified, body_digest, body_bytes, collection_state, failure) VALUES (${String(input["business_id"])}, ${String(input["source_target_id"])}, ${String(input["collector"] ?? "NATIVE_HTTP")}, ${String(input["collector_version"] ?? "native-http/1")}, ${String(input["requested_url"])}, ${String(input["final_url"])}, ${String(input["started_at"])}::timestamptz, ${String(input["completed_at"])}::timestamptz, ${input["http_status"] as number | null}, ${input["content_type"] as string | null}, ${input["etag"] as string | null}, ${input["last_modified"] as string | null}, ${input["body_digest"] as string | null}, ${Number(input["body_bytes"] ?? 0)}, ${String(input["collection_state"])}, ${input["failure"] as string | null}) RETURNING *`) as Array<Record<string, unknown>>
        return rows[0]!
      }),
    latestByTarget: (targetId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT * FROM source_observations WHERE source_target_id = ${targetId} ORDER BY completed_at DESC LIMIT 1`) as Array<Record<string, unknown>>
        return (rows[0] ?? null) as Record<string, unknown> | null
      }),
    historyByTarget: (targetId: string) =>
      Effect.gen(function*() {
        return (yield* sql`SELECT * FROM source_observations WHERE source_target_id = ${targetId} ORDER BY completed_at ASC`) as Array<Record<string, unknown>>
      }),
  })),
)
