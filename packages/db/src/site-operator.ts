// SEARCH_OPERATOR_V1 persistence (Effect, PostgreSQL).
// Tenant scoping: every query filters by business_id; API routes scope the
// business to the session account first (404 otherwise).
// Job model: site_targets -> runs (one active per target) -> page
// observations (append-only) -> findings (mutable status, append-only
// events) -> fix proposals -> mutations -> verifications.
// Network IO always happens outside transactions; each fetch persists
// observation rows atomically afterwards.
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "@effect/sql"
import type { DbEffect } from "./repositories.js"
import {
  NullableIntField,
  NullableTextField,
  NullableTimestampField,
  RowDecodeError,
  TextField,
  TimestampField,
  UuidField,
  BooleanField,
  NullableJsonField,
  decodeRow,
} from "./row-codecs.js"

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))

// ---------------------------------------------------------------------------
// Site targets
// ---------------------------------------------------------------------------

export interface SiteTargetRow {
  readonly id: string
  readonly businessId: string
  readonly rootUrl: string
  readonly canonicalOrigin: string
  readonly pathPrefix: string
  readonly enabled: boolean
  readonly adapterKind: string
  readonly repoRef: unknown
  readonly createdAt: string
}

const SiteTargetSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  root_url: TextField,
  canonical_origin: TextField,
  path_prefix: TextField,
  enabled: BooleanField,
  adapter_kind: TextField,
  repo_ref: NullableJsonField,
  created_at: TimestampField,
})

const decodeSiteTarget = (r: unknown): Effect.Effect<SiteTargetRow, RowDecodeError> =>
  decodeRow(SiteTargetSchema, "site_targets", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      rootUrl: d.root_url,
      canonicalOrigin: d.canonical_origin,
      pathPrefix: d.path_prefix,
      enabled: d.enabled,
      adapterKind: d.adapter_kind,
      repoRef: d.repo_ref ?? {},
      createdAt: iso(d.created_at),
    })),
  )

export class SiteTargetRepository extends Context.Tag("SiteTargetRepository")<
  SiteTargetRepository,
  {
    readonly create: (input: {
      businessId: string
      rootUrl: string
      canonicalOrigin: string
      pathPrefix: string
      adapterKind?: string
      repoRef?: unknown
    }) => DbEffect<SiteTargetRow>
    readonly listByBusiness: (businessId: string) => DbEffect<ReadonlyArray<SiteTargetRow>>
    readonly getScoped: (businessId: string, siteId: string) => DbEffect<SiteTargetRow | null>
  }
>() {}

export const SiteTargetRepositoryLive = Layer.effect(
  SiteTargetRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    create: (input) =>
      sql`INSERT INTO site_targets (business_id, root_url, canonical_origin, path_prefix, adapter_kind, repo_ref) VALUES (${input.businessId}, ${input.rootUrl}, ${input.canonicalOrigin}, ${input.pathPrefix}, ${input.adapterKind ?? "LOCAL_FILE"}, ${JSON.stringify(input.repoRef ?? {})}::jsonb) RETURNING *`.pipe(
        Effect.flatMap((rows) => decodeSiteTarget((rows as Array<unknown>)[0])),
      ),
    listByBusiness: (businessId: string) =>
      sql`SELECT * FROM site_targets WHERE business_id = ${businessId} ORDER BY created_at ASC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeSiteTarget)),
      ),
    getScoped: (businessId: string, siteId: string) =>
      sql`SELECT * FROM site_targets WHERE id = ${siteId} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as SiteTargetRow | null)
          return decodeSiteTarget(r)
        }),
      ),
  })),
)

// ---------------------------------------------------------------------------
// Inspection runs
// ---------------------------------------------------------------------------

export type SiteRunState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED"

export interface SiteRunRow {
  readonly id: string
  readonly businessId: string
  readonly siteTargetId: string
  readonly inspectorVersion: string
  readonly policyVersion: string
  readonly config: unknown
  readonly state: SiteRunState
  readonly queuedAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly failureClass: string | null
  readonly failureDetailSafe: string | null
  readonly urlsInspected: number
  readonly urlsFailed: number
  readonly findingsProduced: number
  readonly bytesDownloaded: number
}

const SiteRunSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  site_target_id: UuidField,
  inspector_version: TextField,
  policy_version: TextField,
  config: NullableJsonField,
  state: TextField,
  queued_at: TimestampField,
  started_at: NullableTimestampField,
  completed_at: NullableTimestampField,
  failure_class: NullableTextField,
  failure_detail_safe: NullableTextField,
  urls_inspected: NullableIntField,
  urls_failed: NullableIntField,
  findings_produced: NullableIntField,
  bytes_downloaded: NullableIntField,
})

const decodeSiteRun = (r: unknown): Effect.Effect<SiteRunRow, RowDecodeError> =>
  decodeRow(SiteRunSchema, "site_inspection_runs", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      siteTargetId: d.site_target_id,
      inspectorVersion: d.inspector_version,
      policyVersion: d.policy_version,
      config: d.config ?? {},
      state: d.state as SiteRunState,
      queuedAt: iso(d.queued_at),
      startedAt: d.started_at == null ? null : iso(d.started_at),
      completedAt: d.completed_at == null ? null : iso(d.completed_at),
      failureClass: d.failure_class,
      failureDetailSafe: d.failure_detail_safe,
      urlsInspected: Number(d.urls_inspected ?? 0),
      urlsFailed: Number(d.urls_failed ?? 0),
      findingsProduced: Number(d.findings_produced ?? 0),
      bytesDownloaded: Number(d.bytes_downloaded ?? 0),
    })),
  )

export class SiteActiveRunConflict extends Data.TaggedError("SiteActiveRunConflict")<{
  readonly activeRunId: string
}> {}

export class SiteRunRepository extends Context.Tag("SiteRunRepository")<
  SiteRunRepository,
  {
    readonly enqueue: (input: { businessId: string; siteTargetId: string; config?: unknown }) => Effect.Effect<SiteRunRow, import("@effect/sql/SqlError").SqlError | RowDecodeError | SiteActiveRunConflict>
    readonly listByTarget: (businessId: string, siteTargetId: string) => DbEffect<ReadonlyArray<SiteRunRow>>
    readonly getScoped: (businessId: string, runId: string) => DbEffect<SiteRunRow | null>
    readonly claimAny: () => DbEffect<SiteRunRow | null>
    readonly heartbeat: (businessId: string, runId: string) => DbEffect<void>
    readonly incrementCounters: (businessId: string, runId: string, patch: { urlsInspected?: number; urlsFailed?: number; findingsProduced?: number; bytesDownloaded?: number }) => DbEffect<void>
    readonly markFinished: (businessId: string, runId: string, state: "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED", failureClass: string | null, failureDetailSafe: string | null) => DbEffect<void>
  }
>() {}

export const SiteRunRepositoryLive = Layer.effect(
  SiteRunRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    enqueue: (input) =>
      Effect.gen(function*() {
        const active = (yield* sql`SELECT id FROM site_inspection_runs WHERE site_target_id = ${input.siteTargetId} AND state IN ('QUEUED','RUNNING') LIMIT 1`) as Array<Record<string, unknown>>
        const found = active[0]
        if (found) return yield* Effect.fail(new SiteActiveRunConflict({ activeRunId: String(found["id"]) }))
        const insert = sql`INSERT INTO site_inspection_runs (business_id, site_target_id, config) VALUES (${input.businessId}, ${input.siteTargetId}, ${JSON.stringify(input.config ?? {})}::jsonb) RETURNING *`.pipe(
          Effect.flatMap((rows) => decodeSiteRun((rows as Array<unknown>)[0])),
        )
        return yield* insert.pipe(
          Effect.catchAll((e) =>
            Effect.gen(function*() {
              if (e instanceof RowDecodeError) return yield* Effect.fail(e)
              const retry = (yield* sql`SELECT id FROM site_inspection_runs WHERE site_target_id = ${input.siteTargetId} AND state IN ('QUEUED','RUNNING') LIMIT 1`) as Array<Record<string, unknown>>
              const r = retry[0]
              if (r) return yield* Effect.fail(new SiteActiveRunConflict({ activeRunId: String(r["id"]) }))
              return yield* Effect.fail(e)
            }),
          ),
        )
      }),
    listByTarget: (businessId: string, siteTargetId: string) =>
      sql`SELECT * FROM site_inspection_runs WHERE business_id = ${businessId} AND site_target_id = ${siteTargetId} ORDER BY queued_at DESC LIMIT 50`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeSiteRun)),
      ),
    getScoped: (businessId: string, runId: string) =>
      sql`SELECT * FROM site_inspection_runs WHERE id = ${runId} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as SiteRunRow | null)
          return decodeSiteRun(r)
        }),
      ),
    claimAny: () =>
      Effect.gen(function*() {
        yield* sql`UPDATE site_inspection_runs AS r SET state = 'QUEUED', heartbeat_at = NULL, attempt_count = attempt_count + 1 WHERE r.state = 'RUNNING' AND ((r.heartbeat_at IS NOT NULL AND r.heartbeat_at < now() - interval '5 minutes') OR (r.heartbeat_at IS NULL AND r.started_at < now() - interval '5 minutes'))`
        const rows = (yield* sql`
          WITH candidate AS (
            SELECT id FROM site_inspection_runs WHERE state = 'QUEUED' ORDER BY queued_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
          )
          UPDATE site_inspection_runs AS r SET state = 'RUNNING', started_at = COALESCE(started_at, now()), heartbeat_at = now()
          FROM candidate WHERE r.id = candidate.id AND r.state = 'QUEUED' RETURNING r.*`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeSiteRun(r)
      }),
    heartbeat: (businessId: string, runId: string) =>
      sql`UPDATE site_inspection_runs SET heartbeat_at = now() WHERE id = ${runId} AND business_id = ${businessId} AND state = 'RUNNING'`.pipe(Effect.asVoid),
    incrementCounters: (businessId, runId, patch) =>
      Effect.gen(function*() {
        if (patch.urlsInspected !== undefined) yield* sql`UPDATE site_inspection_runs SET urls_inspected = urls_inspected + ${patch.urlsInspected} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid)
        if (patch.urlsFailed !== undefined) yield* sql`UPDATE site_inspection_runs SET urls_failed = urls_failed + ${patch.urlsFailed} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid)
        if (patch.findingsProduced !== undefined) yield* sql`UPDATE site_inspection_runs SET findings_produced = findings_produced + ${patch.findingsProduced} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid)
        if (patch.bytesDownloaded !== undefined) yield* sql`UPDATE site_inspection_runs SET bytes_downloaded = bytes_downloaded + ${patch.bytesDownloaded} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid)
      }),
    markFinished: (businessId, runId, state, failureClass, failureDetailSafe) =>
      sql`UPDATE site_inspection_runs SET state = ${state}, completed_at = now(), failure_class = ${failureClass}, failure_detail_safe = ${failureDetailSafe} WHERE id = ${runId} AND business_id = ${businessId} AND state = 'RUNNING'`.pipe(Effect.asVoid),
  })),
)

// ---------------------------------------------------------------------------
// Page observations (append-only)
// ---------------------------------------------------------------------------

export interface SitePageObservationRow {
  readonly id: string
  readonly businessId: string
  readonly runId: string
  readonly siteTargetId: string
  readonly url: string
  readonly canonicalUrl: string
  readonly finalUrl: string
  readonly indexability: string
  readonly httpStatus: number | null
  readonly contentType: string | null
  readonly bodyDigest: string | null
  readonly bodyBytes: number
  readonly collectionState: string
  readonly failure: string | null
  readonly evidence: unknown
  readonly provenance: unknown
}

const SitePageObsSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  run_id: UuidField,
  site_target_id: UuidField,
  url: TextField,
  canonical_url: TextField,
  final_url: TextField,
  indexability: TextField,
  http_status: NullableIntField,
  content_type: NullableTextField,
  body_digest: NullableTextField,
  body_bytes: NullableIntField,
  collection_state: TextField,
  failure: NullableTextField,
  evidence: NullableJsonField,
  provenance: NullableJsonField,
})

const decodePageObs = (r: unknown): Effect.Effect<SitePageObservationRow, RowDecodeError> =>
  decodeRow(SitePageObsSchema, "site_page_observations", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      runId: d.run_id,
      siteTargetId: d.site_target_id,
      url: d.url,
      canonicalUrl: d.canonical_url,
      finalUrl: d.final_url,
      indexability: d.indexability,
      httpStatus: d.http_status === null ? null : Number(d.http_status),
      contentType: d.content_type,
      bodyDigest: d.body_digest,
      bodyBytes: Number(d.body_bytes ?? 0),
      collectionState: d.collection_state,
      failure: d.failure,
      evidence: d.evidence ?? {},
      provenance: d.provenance ?? {},
    })),
  )

export class SitePageObservationRepository extends Context.Tag("SitePageObservationRepository")<
  SitePageObservationRepository,
  {
    readonly insert: (input: {
      businessId: string
      runId: string
      siteTargetId: string
      url: string
      canonicalUrl: string
      finalUrl: string
      discoveredVia?: string
      provenance?: unknown
      startedAt: string
      completedAt: string
      httpStatus?: number | null
      contentType?: string | null
      redirectChain?: unknown
      headers?: unknown
      bodyDigest?: string | null
      bodyBytes?: number
      indexability: string
      evidence?: unknown
      collectionState: string
      failure?: string | null
    }) => DbEffect<SitePageObservationRow>
    readonly listByRun: (businessId: string, runId: string) => DbEffect<ReadonlyArray<SitePageObservationRow>>
  }
>() {}

export const SitePageObservationRepositoryLive = Layer.effect(
  SitePageObservationRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    insert: (input) =>
      Effect.gen(function*() {
        const rows = (yield* sql`INSERT INTO site_page_observations (business_id, run_id, site_target_id, url, canonical_url, final_url, discovered_via, provenance, started_at, completed_at, http_status, content_type, redirect_chain, headers, body_digest, body_bytes, indexability, evidence, collection_state, failure) VALUES (${input.businessId}, ${input.runId}, ${input.siteTargetId}, ${input.url}, ${input.canonicalUrl}, ${input.finalUrl}, ${input.discoveredVia ?? "ROOT"}, ${JSON.stringify(input.provenance ?? {})}::jsonb, ${input.startedAt}::timestamptz, ${input.completedAt}::timestamptz, ${input.httpStatus ?? null}, ${input.contentType ?? null}, ${JSON.stringify(input.redirectChain ?? [])}::jsonb, ${JSON.stringify(input.headers ?? {})}::jsonb, ${input.bodyDigest ?? null}, ${input.bodyBytes ?? 0}, ${input.indexability}, ${JSON.stringify(input.evidence ?? {})}::jsonb, ${input.collectionState}, ${input.failure ?? null}) RETURNING *`) as Array<unknown>
        return yield* decodePageObs(rows[0])
      }),
    listByRun: (businessId: string, runId: string) =>
      sql`SELECT * FROM site_page_observations WHERE business_id = ${businessId} AND run_id = ${runId} ORDER BY created_at ASC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodePageObs)),
      ),
  })),
)

// ---------------------------------------------------------------------------
// Findings (mutable status + append-only events)
// ---------------------------------------------------------------------------

export interface SiteFindingRow {
  readonly id: string
  readonly businessId: string
  readonly siteTargetId: string
  readonly runId: string
  readonly pageObservationId: string | null
  readonly url: string
  readonly canonicalUrl: string
  readonly findingKind: string
  readonly severity: string
  readonly category: string
  readonly status: string
  readonly detectedAt: string
  readonly evidence: unknown
  readonly diagnosis: string
  readonly recommendedAction: string
  readonly confidence: string
  readonly sourceDigest: string | null
  readonly evidenceDigest: string | null
  readonly identityKey: string
}

const SiteFindingSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  site_target_id: UuidField,
  run_id: UuidField,
  page_observation_id: Schema.Union(UuidField, Schema.Null),
  url: TextField,
  canonical_url: TextField,
  finding_kind: TextField,
  severity: TextField,
  category: TextField,
  status: TextField,
  detected_at: TimestampField,
  evidence: NullableJsonField,
  diagnosis: TextField,
  recommended_action: TextField,
  confidence: TextField,
  source_digest: NullableTextField,
  evidence_digest: NullableTextField,
  identity_key: TextField,
})

const decodeFinding = (r: unknown): Effect.Effect<SiteFindingRow, RowDecodeError> =>
  decodeRow(SiteFindingSchema, "site_findings", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      siteTargetId: d.site_target_id,
      runId: d.run_id,
      pageObservationId: d.page_observation_id,
      url: d.url,
      canonicalUrl: d.canonical_url,
      findingKind: d.finding_kind,
      severity: d.severity,
      category: d.category,
      status: d.status,
      detectedAt: iso(d.detected_at),
      evidence: d.evidence ?? {},
      diagnosis: d.diagnosis,
      recommendedAction: d.recommended_action,
      confidence: d.confidence,
      sourceDigest: d.source_digest,
      evidenceDigest: d.evidence_digest,
      identityKey: d.identity_key,
    })),
  )

export class SiteFindingRepository extends Context.Tag("SiteFindingRepository")<
  SiteFindingRepository,
  {
    /** Idempotent insert by identity_key: identical re-inspections return the existing row. */
    readonly upsertByIdentity: (input: {
      businessId: string
      siteTargetId: string
      runId: string
      pageObservationId?: string | null
      url: string
      canonicalUrl: string
      findingKind: string
      severity: string
      category: string
      evidence: unknown
      diagnosis: string
      recommendedAction: string
      confidence: string
      sourceDigest?: string | null
      evidenceDigest?: string | null
      identityKey: string
    }) => DbEffect<{ row: SiteFindingRow; created: boolean }>
    readonly listByBusiness: (businessId: string, status?: string) => DbEffect<ReadonlyArray<SiteFindingRow>>
    readonly listByTarget: (businessId: string, siteTargetId: string) => DbEffect<ReadonlyArray<SiteFindingRow>>
    readonly getScoped: (businessId: string, findingId: string) => DbEffect<SiteFindingRow | null>
    readonly setStatus: (businessId: string, findingId: string, toStatus: string, actor?: string, detail?: string | null, runId?: string | null) => DbEffect<SiteFindingRow | null>
  }
>() {}

export const SiteFindingRepositoryLive = Layer.effect(
  SiteFindingRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    upsertByIdentity: (input) =>
      Effect.gen(function*() {
        const rows = (yield* sql`INSERT INTO site_findings (business_id, site_target_id, run_id, page_observation_id, url, canonical_url, finding_kind, severity, category, evidence, diagnosis, recommended_action, confidence, source_digest, evidence_digest, identity_key) VALUES (${input.businessId}, ${input.siteTargetId}, ${input.runId}, ${input.pageObservationId ?? null}, ${input.url}, ${input.canonicalUrl}, ${input.findingKind}, ${input.severity}, ${input.category}, ${JSON.stringify(input.evidence ?? {})}::jsonb, ${input.diagnosis}, ${input.recommendedAction}, ${input.confidence}, ${input.sourceDigest ?? null}, ${input.evidenceDigest ?? null}, ${input.identityKey}) ON CONFLICT (business_id, identity_key) DO NOTHING RETURNING *`) as Array<unknown>
        if (rows[0]) {
          const row = yield* decodeFinding(rows[0])
          yield* sql`INSERT INTO site_finding_events (business_id, finding_id, run_id, from_status, to_status, actor, detail) VALUES (${input.businessId}, ${row.id}, ${input.runId}, NULL, 'OPEN', 'SYSTEM', 'finding created')`
          return { row, created: true }
        }
        const existing = (yield* sql`SELECT * FROM site_findings WHERE business_id = ${input.businessId} AND identity_key = ${input.identityKey}`) as Array<unknown>
        return { row: yield* decodeFinding(existing[0]), created: false }
      }),
    listByBusiness: (businessId: string, status?: string) =>
      (status
        ? sql`SELECT * FROM site_findings WHERE business_id = ${businessId} AND status = ${status} ORDER BY detected_at DESC LIMIT 200`
        : sql`SELECT * FROM site_findings WHERE business_id = ${businessId} ORDER BY detected_at DESC LIMIT 200`
      ).pipe(Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeFinding))),
    listByTarget: (businessId: string, siteTargetId: string) =>
      sql`SELECT * FROM site_findings WHERE business_id = ${businessId} AND site_target_id = ${siteTargetId} ORDER BY detected_at DESC LIMIT 200`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeFinding)),
      ),
    getScoped: (businessId: string, findingId: string) =>
      sql`SELECT * FROM site_findings WHERE id = ${findingId} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as SiteFindingRow | null)
          return decodeFinding(r)
        }),
      ),
    setStatus: (businessId, findingId, toStatus, actor, detail, runId) =>
      sql.withTransaction(
        Effect.gen(function*() {
          const rows = (yield* sql`SELECT * FROM site_findings WHERE id = ${findingId} AND business_id = ${businessId} FOR UPDATE`) as Array<unknown>
          const current = rows[0]
          if (!current) return null
          const decoded = yield* decodeFinding(current)
          yield* sql`UPDATE site_findings SET status = ${toStatus}, updated_at = now() WHERE id = ${findingId} AND business_id = ${businessId}`
          yield* sql`INSERT INTO site_finding_events (business_id, finding_id, run_id, from_status, to_status, actor, detail) VALUES (${businessId}, ${findingId}, ${runId ?? null}, ${decoded.status}, ${toStatus}, ${actor ?? "SYSTEM"}, ${detail ?? null})`
          const updated = (yield* sql`SELECT * FROM site_findings WHERE id = ${findingId} AND business_id = ${businessId}`) as Array<unknown>
          return yield* decodeFinding(updated[0])
        }),
      ),
  })),
)

// ---------------------------------------------------------------------------
// Finding events (read)
// ---------------------------------------------------------------------------

export interface SiteFindingEventRow {
  readonly id: string
  readonly findingId: string
  readonly fromStatus: string | null
  readonly toStatus: string
  readonly actor: string
  readonly detail: string | null
  readonly createdAt: string
}

export class SiteFindingEventRepository extends Context.Tag("SiteFindingEventRepository")<
  SiteFindingEventRepository,
  { readonly listByFinding: (businessId: string, findingId: string) => DbEffect<ReadonlyArray<SiteFindingEventRow>> }
>() {}

export const SiteFindingEventRepositoryLive = Layer.effect(
  SiteFindingEventRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    listByFinding: (businessId: string, findingId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT id, finding_id, from_status, to_status, actor, detail, created_at FROM site_finding_events WHERE business_id = ${businessId} AND finding_id = ${findingId} ORDER BY created_at ASC`) as Array<Record<string, unknown>>
        return rows.map((r) => ({
          id: String(r["id"]),
          findingId: String(r["finding_id"]),
          fromStatus: (r["from_status"] as string | null) ?? null,
          toStatus: String(r["to_status"]),
          actor: String(r["actor"]),
          detail: (r["detail"] as string | null) ?? null,
          createdAt: iso(r["created_at"]),
        }))
      }),
  })),
)

// ---------------------------------------------------------------------------
// Fix proposals
// ---------------------------------------------------------------------------

export interface SiteFixProposalRow {
  readonly id: string
  readonly businessId: string
  readonly findingId: string
  readonly fixKind: string
  readonly target: string
  readonly filePath: string | null
  readonly beforeText: string | null
  readonly afterText: string | null
  readonly patch: string | null
  readonly rationale: string
  readonly risk: string
  readonly classification: string
  readonly requiresApproval: boolean
  readonly status: string
  readonly generatedAt: string
  readonly approvedBy: string | null
  readonly approvedAt: string | null
  /** Prepared plan (Phase 1 binding); null until prepared. */
  readonly baseRef: string | null
  readonly beforeSha256: string | null
  readonly afterSha256: string | null
  readonly patchSha256: string | null
  readonly preparedAt: string | null
  /** The patch hash the approver approved. */
  readonly approvedPatchSha256: string | null
}

const SiteFixProposalSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  finding_id: UuidField,
  fix_kind: TextField,
  target: TextField,
  file_path: NullableTextField,
  before_text: NullableTextField,
  after_text: NullableTextField,
  patch: NullableTextField,
  rationale: TextField,
  risk: TextField,
  classification: TextField,
  requires_approval: BooleanField,
  status: TextField,
  generated_at: TimestampField,
  approved_by: NullableTextField,
  approved_at: NullableTimestampField,
  base_ref: NullableTextField,
  before_sha256: NullableTextField,
  after_sha256: NullableTextField,
  patch_sha256: NullableTextField,
  prepared_at: NullableTimestampField,
  approved_patch_sha256: NullableTextField,
})

const decodeFixProposal = (r: unknown): Effect.Effect<SiteFixProposalRow, RowDecodeError> =>
  decodeRow(SiteFixProposalSchema, "site_fix_proposals", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      findingId: d.finding_id,
      fixKind: d.fix_kind,
      target: d.target,
      filePath: d.file_path,
      beforeText: d.before_text,
      afterText: d.after_text,
      patch: d.patch,
      rationale: d.rationale,
      risk: d.risk,
      classification: d.classification,
      requiresApproval: d.requires_approval,
      status: d.status,
      generatedAt: iso(d.generated_at),
      approvedBy: d.approved_by,
      approvedAt: d.approved_at == null ? null : iso(d.approved_at),
      baseRef: d.base_ref,
      beforeSha256: d.before_sha256,
      afterSha256: d.after_sha256,
      patchSha256: d.patch_sha256,
      preparedAt: d.prepared_at == null ? null : iso(d.prepared_at),
      approvedPatchSha256: d.approved_patch_sha256,
    })),
  )

export interface PreparedPlanInput {
  readonly filePath: string
  readonly baseRef: string | null
  readonly beforeSha256: string
  readonly afterSha256: string
  readonly patchSha256: string
  readonly patch: string
}

export class SiteFixProposalRepository extends Context.Tag("SiteFixProposalRepository")<
  SiteFixProposalRepository,
  {
    readonly create: (input: {
      businessId: string
      findingId: string
      fixKind: string
      target: string
      filePath?: string | null
      beforeText?: string | null
      afterText?: string | null
      patch?: string | null
      rationale: string
      risk: string
      classification: string
      requiresApproval: boolean
    }) => DbEffect<SiteFixProposalRow>
    readonly listByFinding: (businessId: string, findingId: string) => DbEffect<ReadonlyArray<SiteFixProposalRow>>
    readonly getScoped: (businessId: string, proposalId: string) => DbEffect<SiteFixProposalRow | null>
    readonly setStatus: (businessId: string, proposalId: string, status: "APPROVED" | "REJECTED" | "SUPERSEDED", approvedBy?: string | null) => DbEffect<SiteFixProposalRow | null>
    /**
     * Store the exact prepared change. A different patch on an APPROVED
     * proposal returns it to PROPOSED (approval invalidated). Only
     * PROPOSED/APPROVED proposals can be prepared.
     */
    readonly recordPlan: (businessId: string, proposalId: string, plan: PreparedPlanInput) => DbEffect<{ proposal: SiteFixProposalRow; approvalInvalidated: boolean } | null>
    /**
     * PROPOSED -> APPROVED only if the prepared patch is still the one the
     * reviewer saw (reviewedPatchSha256); binds approved_patch_sha256 to it.
     */
    readonly approveBound: (businessId: string, proposalId: string, approvedBy: string, reviewedPatchSha256: string) => DbEffect<SiteFixProposalRow | null>
  }
>() {}

export const SiteFixProposalRepositoryLive = Layer.effect(
  SiteFixProposalRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    create: (input) =>
      Effect.gen(function*() {
        // Supersede prior PROPOSED rows for the same finding+kind (history
        // preserved, never deleted).
        yield* sql`UPDATE site_fix_proposals SET status = 'SUPERSEDED' WHERE business_id = ${input.businessId} AND finding_id = ${input.findingId} AND fix_kind = ${input.fixKind} AND status = 'PROPOSED'`
        const rows = (yield* sql`INSERT INTO site_fix_proposals (business_id, finding_id, fix_kind, target, file_path, before_text, after_text, patch, rationale, risk, classification, requires_approval) VALUES (${input.businessId}, ${input.findingId}, ${input.fixKind}, ${input.target}, ${input.filePath ?? null}, ${input.beforeText ?? null}, ${input.afterText ?? null}, ${input.patch ?? null}, ${input.rationale}, ${input.risk}, ${input.classification}, ${input.requiresApproval}) RETURNING *`) as Array<unknown>
        return yield* decodeFixProposal(rows[0])
      }),
    listByFinding: (businessId: string, findingId: string) =>
      sql`SELECT * FROM site_fix_proposals WHERE business_id = ${businessId} AND finding_id = ${findingId} ORDER BY generated_at DESC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeFixProposal)),
      ),
    getScoped: (businessId: string, proposalId: string) =>
      sql`SELECT * FROM site_fix_proposals WHERE id = ${proposalId} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as SiteFixProposalRow | null)
          return decodeFixProposal(r)
        }),
      ),
    setStatus: (businessId, proposalId, status, approvedBy) =>
      Effect.gen(function*() {
        const rows = (yield* sql`UPDATE site_fix_proposals SET status = ${status}, approved_by = ${approvedBy ?? null}, approved_at = CASE WHEN ${status} = 'APPROVED' THEN now() ELSE approved_at END WHERE id = ${proposalId} AND business_id = ${businessId} RETURNING *`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeFixProposal(r)
      }),
    recordPlan: (businessId, proposalId, plan) =>
      Effect.gen(function*() {
        const rows = (yield* sql`
          WITH prev AS (
            SELECT id, status FROM site_fix_proposals
            WHERE id = ${proposalId} AND business_id = ${businessId} AND status IN ('PROPOSED','APPROVED')
            FOR UPDATE
          )
          UPDATE site_fix_proposals p SET
            file_path = ${plan.filePath}, base_ref = ${plan.baseRef}, before_sha256 = ${plan.beforeSha256},
            after_sha256 = ${plan.afterSha256}, patch_sha256 = ${plan.patchSha256}, patch = ${plan.patch},
            prepared_at = now(),
            status = CASE WHEN p.status = 'APPROVED' AND p.approved_patch_sha256 IS DISTINCT FROM ${plan.patchSha256} THEN 'PROPOSED' ELSE p.status END
          FROM prev WHERE p.id = prev.id
          RETURNING p.*, prev.status AS prev_status`) as Array<Record<string, unknown>>
        const r = rows[0]
        if (!r) return null
        const proposal = yield* decodeFixProposal(r)
        return { proposal, approvalInvalidated: r["prev_status"] === "APPROVED" && proposal.status === "PROPOSED" }
      }),
    approveBound: (businessId, proposalId, approvedBy, reviewedPatchSha256) =>
      Effect.gen(function*() {
        const rows = (yield* sql`UPDATE site_fix_proposals SET status = 'APPROVED', approved_by = ${approvedBy}, approved_at = now(), approved_patch_sha256 = patch_sha256 WHERE id = ${proposalId} AND business_id = ${businessId} AND status = 'PROPOSED' AND patch_sha256 = ${reviewedPatchSha256} RETURNING *`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeFixProposal(r)
      }),
  })),
)

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface SiteMutationRow {
  readonly id: string
  readonly businessId: string
  readonly fixProposalId: string
  readonly findingId: string
  readonly adapterKind: string
  readonly branch: string | null
  readonly commitSha: string | null
  readonly prNumber: number | null
  readonly prUrl: string | null
  readonly state: string
  readonly detail: string | null
  readonly createdAt: string
  /** Phase 1 binding: what was approved and claimed (null on legacy rows). */
  readonly targetPath: string | null
  readonly baseRef: string | null
  readonly beforeSha256: string | null
  readonly afterSha256: string | null
  readonly approvedPatchSha256: string | null
  readonly approvedBy: string | null
  readonly approvedAt: string | null
  readonly idempotencyKey: string | null
  readonly failureCode: string | null
  /** Hash actually read back after the write (differs only on MUTATION_FAILED). */
  readonly appliedAfterSha256: string | null
  /** The exact patch that was approved and claimed (replays return it). */
  readonly patch: string | null
}

const SiteMutationSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  fix_proposal_id: UuidField,
  finding_id: UuidField,
  adapter_kind: TextField,
  branch: NullableTextField,
  commit_sha: NullableTextField,
  pr_number: NullableIntField,
  pr_url: NullableTextField,
  state: TextField,
  detail: NullableTextField,
  created_at: TimestampField,
  target_path: NullableTextField,
  base_ref: NullableTextField,
  before_sha256: NullableTextField,
  after_sha256: NullableTextField,
  approved_patch_sha256: NullableTextField,
  approved_by: NullableTextField,
  approved_at: NullableTimestampField,
  idempotency_key: NullableTextField,
  failure_code: NullableTextField,
  applied_after_sha256: NullableTextField,
  patch: NullableTextField,
})

const decodeMutation = (r: unknown): Effect.Effect<SiteMutationRow, RowDecodeError> =>
  decodeRow(SiteMutationSchema, "site_mutations", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      fixProposalId: d.fix_proposal_id,
      findingId: d.finding_id,
      adapterKind: d.adapter_kind,
      branch: d.branch,
      commitSha: d.commit_sha,
      prNumber: d.pr_number === null ? null : Number(d.pr_number),
      prUrl: d.pr_url,
      state: d.state,
      detail: d.detail,
      createdAt: iso(d.created_at),
      targetPath: d.target_path,
      baseRef: d.base_ref,
      beforeSha256: d.before_sha256,
      afterSha256: d.after_sha256,
      approvedPatchSha256: d.approved_patch_sha256,
      approvedBy: d.approved_by,
      approvedAt: d.approved_at == null ? null : iso(d.approved_at),
      idempotencyKey: d.idempotency_key,
      failureCode: d.failure_code,
      appliedAfterSha256: d.applied_after_sha256,
      patch: d.patch,
    })),
  )

export interface MutationClaimInput {
  readonly businessId: string
  readonly fixProposalId: string
  readonly findingId: string
  readonly adapterKind: string
  readonly targetPath: string
  readonly baseRef: string | null
  readonly beforeSha256: string
  readonly afterSha256: string
  readonly approvedPatchSha256: string
  readonly approvedBy: string
  readonly approvedAt: string
  readonly idempotencyKey: string
  readonly patch: string
}

export class SiteMutationRepository extends Context.Tag("SiteMutationRepository")<
  SiteMutationRepository,
  {
    readonly create: (input: {
      businessId: string
      fixProposalId: string
      findingId: string
      adapterKind: string
      branch?: string | null
      commitSha?: string | null
      prNumber?: number | null
      prUrl?: string | null
      state?: string
      detail?: string | null
    }) => DbEffect<SiteMutationRow>
    readonly listByFinding: (businessId: string, findingId: string) => DbEffect<ReadonlyArray<SiteMutationRow>>
    readonly getScoped: (businessId: string, mutationId: string) => DbEffect<SiteMutationRow | null>
    /** Guarded transition: applies only while the row is still in expectedState. */
    readonly markState: (businessId: string, mutationId: string, state: string, detail?: string | null, extra?: { prNumber?: number | null; prUrl?: string | null; commitSha?: string | null; branch?: string | null }, expectedState?: string) => DbEffect<SiteMutationRow | null>
    /**
     * Claim a mutation (state APPLYING) before any write. Writes nothing and
     * returns claimed = false with the blocking row when the same (business,
     * idempotency key) exists, or when the same approved patch already has
     * an in-flight or successful execution.
     */
    readonly claim: (input: MutationClaimInput) => DbEffect<{ claimed: boolean; row: SiteMutationRow }>
    readonly findByIdempotencyKey: (businessId: string, idempotencyKey: string) => DbEffect<SiteMutationRow | null>
    /** APPLYING -> final state (success or a failure code). */
    readonly complete: (businessId: string, mutationId: string, outcome: {
      state: "CREATED" | "BRANCH_CREATED" | "FAILED"
      failureCode: string | null
      branch: string | null
      appliedAfterSha256: string | null
      detail: string
    }) => DbEffect<SiteMutationRow | null>
  }
>() {}

export const SiteMutationRepositoryLive = Layer.effect(
  SiteMutationRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    create: (input) =>
      Effect.gen(function*() {
        const rows = (yield* sql`INSERT INTO site_mutations (business_id, fix_proposal_id, finding_id, adapter_kind, branch, commit_sha, pr_number, pr_url, state, detail) VALUES (${input.businessId}, ${input.fixProposalId}, ${input.findingId}, ${input.adapterKind}, ${input.branch ?? null}, ${input.commitSha ?? null}, ${input.prNumber ?? null}, ${input.prUrl ?? null}, ${input.state ?? "CREATED"}, ${input.detail ?? null}) RETURNING *`) as Array<unknown>
        return yield* decodeMutation(rows[0])
      }),
    listByFinding: (businessId: string, findingId: string) =>
      sql`SELECT * FROM site_mutations WHERE business_id = ${businessId} AND finding_id = ${findingId} ORDER BY created_at DESC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeMutation)),
      ),
    getScoped: (businessId: string, mutationId: string) =>
      sql`SELECT * FROM site_mutations WHERE id = ${mutationId} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as SiteMutationRow | null)
          return decodeMutation(r)
        }),
      ),
    markState: (businessId, mutationId, state, detail, extra, expectedState) =>
      Effect.gen(function*() {
        const rows = (yield* sql`UPDATE site_mutations SET state = ${state}, detail = COALESCE(${detail ?? null}, detail), pr_number = COALESCE(${extra?.prNumber ?? null}, pr_number), pr_url = COALESCE(${extra?.prUrl ?? null}, pr_url), commit_sha = COALESCE(${extra?.commitSha ?? null}, commit_sha), branch = COALESCE(${extra?.branch ?? null}, branch), updated_at = now() WHERE id = ${mutationId} AND business_id = ${businessId} AND (${expectedState ?? null}::text IS NULL OR state = ${expectedState ?? null}) RETURNING *`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeMutation(r)
      }),
    claim: (input) =>
      Effect.gen(function*() {
        const inserted = (yield* sql`
          INSERT INTO site_mutations (business_id, fix_proposal_id, finding_id, adapter_kind, state, target_path, base_ref, before_sha256, after_sha256, approved_patch_sha256, approved_by, approved_at, idempotency_key, patch)
          VALUES (${input.businessId}, ${input.fixProposalId}, ${input.findingId}, ${input.adapterKind}, 'APPLYING', ${input.targetPath}, ${input.baseRef}, ${input.beforeSha256}, ${input.afterSha256}, ${input.approvedPatchSha256}, ${input.approvedBy}, ${input.approvedAt}, ${input.idempotencyKey}, ${input.patch})
          ON CONFLICT DO NOTHING
          RETURNING *`) as Array<unknown>
        if (inserted[0]) return { claimed: true, row: yield* decodeMutation(inserted[0]) }
        // Blocked by either unique index: same key, or this approval already executing/executed.
        const existing = (yield* sql`
          SELECT * FROM site_mutations
          WHERE business_id = ${input.businessId}
            AND (idempotency_key = ${input.idempotencyKey}
              OR (fix_proposal_id = ${input.fixProposalId} AND approved_patch_sha256 = ${input.approvedPatchSha256} AND idempotency_key IS NOT NULL AND state <> 'FAILED'))
          ORDER BY (idempotency_key = ${input.idempotencyKey}) DESC
          LIMIT 1`) as Array<unknown>
        if (!existing[0]) return yield* Effect.die(new Error("mutation claim conflicted but no blocking row is visible"))
        return { claimed: false, row: yield* decodeMutation(existing[0]) }
      }),
    findByIdempotencyKey: (businessId, idempotencyKey) =>
      sql`SELECT * FROM site_mutations WHERE business_id = ${businessId} AND idempotency_key = ${idempotencyKey}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          return r ? decodeMutation(r) : Effect.succeed(null as SiteMutationRow | null)
        }),
      ),
    complete: (businessId, mutationId, outcome) =>
      Effect.gen(function*() {
        const rows = (yield* sql`UPDATE site_mutations SET state = ${outcome.state}, failure_code = ${outcome.failureCode}, branch = COALESCE(${outcome.branch}, branch), applied_after_sha256 = ${outcome.appliedAfterSha256}, detail = ${outcome.detail}, updated_at = now() WHERE id = ${mutationId} AND business_id = ${businessId} AND state = 'APPLYING' RETURNING *`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeMutation(r)
      }),
  })),
)

// ---------------------------------------------------------------------------
// Verifications
// ---------------------------------------------------------------------------

export interface SiteVerificationRow {
  readonly id: string
  readonly businessId: string
  readonly findingId: string
  readonly mutationId: string | null
  readonly runId: string | null
  readonly beforeDigest: string | null
  readonly afterDigest: string | null
  readonly result: string
  readonly detail: string | null
  readonly checkedAt: string
}

export class SiteVerificationRepository extends Context.Tag("SiteVerificationRepository")<
  SiteVerificationRepository,
  {
    readonly create: (input: {
      businessId: string
      findingId: string
      mutationId?: string | null
      runId?: string | null
      beforeDigest?: string | null
      afterDigest?: string | null
      result: string
      detail?: string | null
    }) => DbEffect<SiteVerificationRow>
    readonly latestForFinding: (businessId: string, findingId: string) => DbEffect<SiteVerificationRow | null>
    readonly listByFinding: (businessId: string, findingId: string) => DbEffect<ReadonlyArray<SiteVerificationRow>>
  }
>() {}

export const SiteVerificationRepositoryLive = Layer.effect(
  SiteVerificationRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    create: (input) =>
      Effect.gen(function*() {
        const rows = (yield* sql`INSERT INTO site_verifications (business_id, finding_id, mutation_id, run_id, before_digest, after_digest, result, detail) VALUES (${input.businessId}, ${input.findingId}, ${input.mutationId ?? null}, ${input.runId ?? null}, ${input.beforeDigest ?? null}, ${input.afterDigest ?? null}, ${input.result}, ${input.detail ?? null}) RETURNING id, business_id, finding_id, mutation_id, run_id, before_digest, after_digest, result, detail, checked_at`) as Array<Record<string, unknown>>
        const r = rows[0]!
        return {
          id: String(r["id"]),
          businessId: String(r["business_id"]),
          findingId: String(r["finding_id"]),
          mutationId: (r["mutation_id"] as string | null) ?? null,
          runId: (r["run_id"] as string | null) ?? null,
          beforeDigest: (r["before_digest"] as string | null) ?? null,
          afterDigest: (r["after_digest"] as string | null) ?? null,
          result: String(r["result"]),
          detail: (r["detail"] as string | null) ?? null,
          checkedAt: iso(r["checked_at"]),
        }
      }),
    latestForFinding: (businessId: string, findingId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT id, business_id, finding_id, mutation_id, run_id, before_digest, after_digest, result, detail, checked_at FROM site_verifications WHERE business_id = ${businessId} AND finding_id = ${findingId} ORDER BY checked_at DESC LIMIT 1`) as Array<Record<string, unknown>>
        const r = rows[0]
        if (!r) return null
        return {
          id: String(r["id"]),
          businessId: String(r["business_id"]),
          findingId: String(r["finding_id"]),
          mutationId: (r["mutation_id"] as string | null) ?? null,
          runId: (r["run_id"] as string | null) ?? null,
          beforeDigest: (r["before_digest"] as string | null) ?? null,
          afterDigest: (r["after_digest"] as string | null) ?? null,
          result: String(r["result"]),
          detail: (r["detail"] as string | null) ?? null,
          checkedAt: iso(r["checked_at"]),
        }
      }),
    listByFinding: (businessId: string, findingId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT id, business_id, finding_id, mutation_id, run_id, before_digest, after_digest, result, detail, checked_at FROM site_verifications WHERE business_id = ${businessId} AND finding_id = ${findingId} ORDER BY checked_at ASC`) as Array<Record<string, unknown>>
        return rows.map((r) => ({
          id: String(r["id"]),
          businessId: String(r["business_id"]),
          findingId: String(r["finding_id"]),
          mutationId: (r["mutation_id"] as string | null) ?? null,
          runId: (r["run_id"] as string | null) ?? null,
          beforeDigest: (r["before_digest"] as string | null) ?? null,
          afterDigest: (r["after_digest"] as string | null) ?? null,
          result: String(r["result"]),
          detail: (r["detail"] as string | null) ?? null,
          checkedAt: iso(r["checked_at"]),
        }))
      }),
  })),
)

// ---------------------------------------------------------------------------
// Operator events + GSC properties
// ---------------------------------------------------------------------------

export class SiteOperatorEventRepository extends Context.Tag("SiteOperatorEventRepository")<
  SiteOperatorEventRepository,
  {
    readonly append: (input: { businessId: string; runId?: string | null; findingId?: string | null; kind: string; payload?: unknown }) => DbEffect<void>
    readonly listByRun: (businessId: string, runId: string) => DbEffect<ReadonlyArray<{ kind: string; payload: unknown; createdAt: string }>>
  }
>() {}

export const SiteOperatorEventRepositoryLive = Layer.effect(
  SiteOperatorEventRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    append: (input) =>
      sql`INSERT INTO site_operator_events (business_id, run_id, finding_id, kind, payload) VALUES (${input.businessId}, ${input.runId ?? null}, ${input.findingId ?? null}, ${input.kind}, ${JSON.stringify(input.payload ?? {})}::jsonb)`.pipe(Effect.asVoid),
    listByRun: (businessId: string, runId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT kind, payload, created_at FROM site_operator_events WHERE business_id = ${businessId} AND run_id = ${runId} ORDER BY created_at ASC`) as Array<Record<string, unknown>>
        return rows.map((r) => ({ kind: String(r["kind"]), payload: (r["payload"] as unknown) ?? {}, createdAt: iso(r["created_at"]) }))
      }),
  })),
)

export class SiteGscRepository extends Context.Tag("SiteGscRepository")<
  SiteGscRepository,
  {
    readonly upsert: (businessId: string, propertyUri: string, status: string, detail?: string | null) => DbEffect<void>
    readonly listByBusiness: (businessId: string) => DbEffect<ReadonlyArray<{ id: string; propertyUri: string; status: string; detail: string | null }>>
  }
>() {}

export const SiteGscRepositoryLive = Layer.effect(
  SiteGscRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    upsert: (businessId: string, propertyUri: string, status: string, detail?: string | null) =>
      sql`INSERT INTO site_gsc_properties (business_id, property_uri, status, detail) VALUES (${businessId}, ${propertyUri}, ${status}, ${detail ?? null}) ON CONFLICT (business_id, property_uri) DO UPDATE SET status = ${status}, detail = ${detail ?? null}`.pipe(Effect.asVoid),
    listByBusiness: (businessId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT id, property_uri, status, detail FROM site_gsc_properties WHERE business_id = ${businessId} ORDER BY created_at ASC`) as Array<Record<string, unknown>>
        return rows.map((r) => ({ id: String(r["id"]), propertyUri: String(r["property_uri"]), status: String(r["status"]), detail: (r["detail"] as string | null) ?? null }))
      }),
  })),
)

export const SiteOperatorRepositoriesLive = Layer.mergeAll(
  SiteTargetRepositoryLive,
  SiteRunRepositoryLive,
  SitePageObservationRepositoryLive,
  SiteFindingRepositoryLive,
  SiteFindingEventRepositoryLive,
  SiteFixProposalRepositoryLive,
  SiteMutationRepositoryLive,
  SiteVerificationRepositoryLive,
  SiteOperatorEventRepositoryLive,
  SiteGscRepositoryLive,
)
