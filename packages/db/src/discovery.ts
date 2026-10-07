// Representation Discovery V1 persistence (Effect, PostgreSQL).
// Tenant scoping rule: every query filters by business_id; API routes
// additionally scope the business to the session account (getScoped) and
// treat anything else as 404, never leaking cross-account existence.
//
// Job model: scopes (operator-declared crawl roots) -> runs (one active per
// scope, guarded by a partial unique index) -> frontier (durable per-URL
// queue: PENDING -> IN_PROGRESS -> DONE | SKIPPED) -> observations + matches
// (append-only evidence). The worker fetches over the network OUTSIDE any
// transaction and persists observation + matches + frontier-DONE atomically.
//
// Pure crawl policy (scope validation, robots, sitemaps, frontier order,
// matching, authority snapshots) lives in @openrecord/discovery; this module
// is storage only and never parses HTML or fetches.
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import type { DbEffect } from "./repositories.js"
import {
  BooleanField,
  NullableIntField,
  NullableTextField,
  NullableTimestampField,
  NullableUuidField,
  RowDecodeError,
  TextField,
  TimestampField,
  UuidField,
  IntField,
  decodeRow,
} from "./row-codecs.js"

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))

// Version defaults mirror @openrecord/discovery MATCHER_VERSION /
// POLICY_VERSION (kept as literals here so storage never constrains the
// policy package; runs may also pin explicit versions per enqueue).
const DEFAULT_MATCHER_VERSION = "discovery-matcher/1"
const DEFAULT_POLICY_VERSION = "discovery-policy/1"

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export interface DiscoveryScopeRow {
  readonly id: string
  readonly businessId: string
  readonly rootUrl: string
  readonly canonicalOrigin: string
  readonly pathPrefix: string
  readonly enabled: boolean
  readonly ownershipAssertion: string
  readonly createdAt: string
}

const DiscoveryScopeSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  root_url: TextField,
  canonical_origin: TextField,
  path_prefix: TextField,
  enabled: BooleanField,
  ownership_assertion: NullableTextField,
  created_at: TimestampField,
})

const decodeScope = (r: unknown): Effect.Effect<DiscoveryScopeRow, RowDecodeError> =>
  decodeRow(DiscoveryScopeSchema, "discovery_scopes", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      rootUrl: d.root_url,
      canonicalOrigin: d.canonical_origin,
      pathPrefix: d.path_prefix,
      enabled: d.enabled,
      ownershipAssertion: d.ownership_assertion ?? "OPERATOR_ASSERTED_OWNED",
      createdAt: iso(d.created_at),
    })),
  )

export class DiscoveryScopeRepository extends Context.Tag("DiscoveryScopeRepository")<
  DiscoveryScopeRepository,
  {
    readonly create: (input: { businessId: string; rootUrl: string; canonicalOrigin: string; pathPrefix: string }) => DbEffect<DiscoveryScopeRow>
    readonly listByBusiness: (businessId: string) => DbEffect<ReadonlyArray<DiscoveryScopeRow>>
    readonly getScoped: (businessId: string, scopeId: string) => DbEffect<DiscoveryScopeRow | null>
  }
>() {}

export const DiscoveryScopeRepositoryLive = Layer.effect(
  DiscoveryScopeRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    create: (input) =>
      sql`INSERT INTO discovery_scopes (business_id, root_url, canonical_origin, path_prefix) VALUES (${input.businessId}, ${input.rootUrl}, ${input.canonicalOrigin}, ${input.pathPrefix}) RETURNING *`.pipe(
        Effect.flatMap((rows) => decodeScope((rows as Array<unknown>)[0])),
      ),
    listByBusiness: (businessId: string) =>
      sql`SELECT * FROM discovery_scopes WHERE business_id = ${businessId} ORDER BY created_at ASC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeScope)),
      ),
    getScoped: (businessId: string, scopeId: string) =>
      sql`SELECT * FROM discovery_scopes WHERE id = ${scopeId} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as DiscoveryScopeRow | null)
          return decodeScope(r)
        }),
      ),
  })),
)

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type DiscoveryRunState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED"

export interface DiscoveryRunRow {
  readonly id: string
  readonly businessId: string
  readonly scopeId: string
  readonly authoritySnapshotDigest: string | null
  readonly matcherVersion: string
  readonly policyVersion: string
  readonly state: DiscoveryRunState
  readonly queuedAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly heartbeatAt: string | null
  readonly attemptCount: number
  readonly failureClass: string | null
  readonly failureDetailSafe: string | null
  readonly pagesFetched: number
  readonly pagesNotModified: number
  readonly pagesFailed: number
  readonly pagesSkippedRobots: number
  readonly bytesDownloaded: number
  readonly candidatesFound: number
}

const DiscoveryRunSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  scope_id: UuidField,
  authority_snapshot_digest: NullableTextField,
  matcher_version: NullableTextField,
  policy_version: NullableTextField,
  state: TextField,
  queued_at: TimestampField,
  started_at: NullableTimestampField,
  completed_at: NullableTimestampField,
  heartbeat_at: NullableTimestampField,
  attempt_count: NullableIntField,
  failure_class: NullableTextField,
  failure_detail_safe: NullableTextField,
  pages_fetched: NullableIntField,
  pages_not_modified: NullableIntField,
  pages_failed: NullableIntField,
  pages_skipped_robots: NullableIntField,
  bytes_downloaded: NullableIntField,
  candidates_found: NullableIntField,
})

const decodeDiscoveryRun = (r: unknown): Effect.Effect<DiscoveryRunRow, RowDecodeError> =>
  decodeRow(DiscoveryRunSchema, "discovery_runs", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      scopeId: d.scope_id,
      authoritySnapshotDigest: d.authority_snapshot_digest,
      matcherVersion: d.matcher_version ?? DEFAULT_MATCHER_VERSION,
      policyVersion: d.policy_version ?? DEFAULT_POLICY_VERSION,
      state: d.state as DiscoveryRunState,
      queuedAt: iso(d.queued_at),
      startedAt: d.started_at == null ? null : iso(d.started_at),
      completedAt: d.completed_at == null ? null : iso(d.completed_at),
      heartbeatAt: d.heartbeat_at == null ? null : iso(d.heartbeat_at),
      attemptCount: Number(d.attempt_count ?? 0),
      failureClass: d.failure_class,
      failureDetailSafe: d.failure_detail_safe,
      pagesFetched: Number(d.pages_fetched ?? 0),
      pagesNotModified: Number(d.pages_not_modified ?? 0),
      pagesFailed: Number(d.pages_failed ?? 0),
      pagesSkippedRobots: Number(d.pages_skipped_robots ?? 0),
      bytesDownloaded: Number(d.bytes_downloaded ?? 0),
      candidatesFound: Number(d.candidates_found ?? 0),
    })),
  )

/** A second active (QUEUED or RUNNING) run for the same scope. Maps to HTTP 409. */
export class DiscoveryActiveRunConflict extends Data.TaggedError("DiscoveryActiveRunConflict")<{
  readonly activeRunId: string
}> {}

export interface DiscoveryRunCounters {
  readonly pagesFetched?: number
  readonly pagesNotModified?: number
  readonly pagesFailed?: number
  readonly pagesSkippedRobots?: number
  readonly bytesDownloaded?: number
  readonly candidatesFound?: number
}

export class DiscoveryRunRepository extends Context.Tag("DiscoveryRunRepository")<
  DiscoveryRunRepository,
  {
    /** Enqueue a run. Fails with DiscoveryActiveRunConflict when the scope already has one. */
    readonly enqueue: (input: { businessId: string; scopeId: string; matcherVersion?: string; policyVersion?: string }) => Effect.Effect<DiscoveryRunRow, SqlError | RowDecodeError | DiscoveryActiveRunConflict>
    readonly listByScope: (businessId: string, scopeId: string) => DbEffect<ReadonlyArray<DiscoveryRunRow>>
    readonly getScoped: (businessId: string, runId: string) => DbEffect<DiscoveryRunRow | null>
    /** Scoped atomic claim: oldest QUEUED for this scope -> RUNNING. */
    readonly claimOne: (businessId: string, scopeId: string) => DbEffect<DiscoveryRunRow | null>
    /** Global atomic claim for the worker loop: oldest QUEUED (any scope) -> RUNNING. */
    readonly claimAny: () => DbEffect<DiscoveryRunRow | null>
    readonly heartbeat: (businessId: string, runId: string) => DbEffect<void>
    readonly setAuthorityDigest: (businessId: string, runId: string, digest: string) => DbEffect<void>
    readonly incrementCounters: (businessId: string, runId: string, patch: DiscoveryRunCounters) => DbEffect<void>
    /** Terminal transition: only RUNNING -> SUCCEEDED | PARTIAL | FAILED. */
    readonly markFinished: (
      businessId: string,
      runId: string,
      state: "SUCCEEDED" | "PARTIAL" | "FAILED",
      failureClass: string | null,
      failureDetailSafe: string | null,
    ) => DbEffect<void>
  }
>() {}

// Expired leases return to QUEUED (attempts incremented) before claiming, so
// a worker crash between claim and finish never strands a scope in RUNNING.
// Completed runs (SUCCEEDED/PARTIAL/FAILED) are never returned.

export const DiscoveryRunRepositoryLive = Layer.effect(
  DiscoveryRunRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    enqueue: (input) =>
      Effect.gen(function*() {
        const active = (yield* sql`SELECT id FROM discovery_runs WHERE scope_id = ${input.scopeId} AND state IN ('QUEUED','RUNNING') LIMIT 1`) as Array<Record<string, unknown>>
        const found = active[0]
        if (found) {
          return yield* Effect.fail(new DiscoveryActiveRunConflict({ activeRunId: String(found["id"]) }))
        }
        const insert = sql`INSERT INTO discovery_runs (business_id, scope_id, matcher_version, policy_version) VALUES (${input.businessId}, ${input.scopeId}, ${input.matcherVersion ?? DEFAULT_MATCHER_VERSION}, ${input.policyVersion ?? DEFAULT_POLICY_VERSION}) RETURNING *`.pipe(
          Effect.flatMap((rows) => decodeDiscoveryRun((rows as Array<unknown>)[0])),
        )
        // Race backstop: the partial unique index rejects a concurrent
        // duplicate; translate it into the same typed conflict.
        return yield* insert.pipe(
          Effect.catchAll((e) =>
            Effect.gen(function*() {
              // RowDecodeError from our own insert is a real decode failure,
              // not a conflict: propagate it instead of masking as 409.
              if (e instanceof RowDecodeError) return yield* Effect.fail(e)
              const retry = (yield* sql`SELECT id FROM discovery_runs WHERE scope_id = ${input.scopeId} AND state IN ('QUEUED','RUNNING') LIMIT 1`) as Array<Record<string, unknown>>
              const r = retry[0]
              if (r) return yield* Effect.fail(new DiscoveryActiveRunConflict({ activeRunId: String(r["id"]) }))
              return yield* Effect.fail(e)
            }),
          ),
        )
      }),
    listByScope: (businessId: string, scopeId: string) =>
      sql`SELECT * FROM discovery_runs WHERE business_id = ${businessId} AND scope_id = ${scopeId} ORDER BY queued_at DESC LIMIT 100`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeDiscoveryRun)),
      ),
    getScoped: (businessId: string, runId: string) =>
      sql`SELECT * FROM discovery_runs WHERE id = ${runId} AND business_id = ${businessId}`.pipe(
        Effect.flatMap((rows) => {
          const r = (rows as Array<unknown>)[0]
          if (!r) return Effect.succeed(null as DiscoveryRunRow | null)
          return decodeDiscoveryRun(r)
        }),
      ),
    claimOne: (businessId: string, scopeId: string) =>
      Effect.gen(function*() {
        yield* sql`UPDATE discovery_runs AS r SET state = 'QUEUED', heartbeat_at = NULL, attempt_count = attempt_count + 1 WHERE r.business_id = ${businessId} AND r.scope_id = ${scopeId} AND r.state = 'RUNNING' AND ((r.heartbeat_at IS NOT NULL AND r.heartbeat_at < now() - interval '5 minutes') OR (r.heartbeat_at IS NULL AND r.started_at < now() - interval '5 minutes'))`
        const rows = (yield* sql`
          WITH candidate AS (
            SELECT id FROM discovery_runs
            WHERE business_id = ${businessId} AND scope_id = ${scopeId} AND state = 'QUEUED'
            ORDER BY queued_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE discovery_runs AS r
          SET state = 'RUNNING', started_at = COALESCE(started_at, now()), heartbeat_at = now()
          FROM candidate
          WHERE r.id = candidate.id AND r.state = 'QUEUED'
          RETURNING r.*`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeDiscoveryRun(r)
      }),
    claimAny: () =>
      Effect.gen(function*() {
        yield* sql`UPDATE discovery_runs AS r SET state = 'QUEUED', heartbeat_at = NULL, attempt_count = attempt_count + 1 WHERE r.state = 'RUNNING' AND ((r.heartbeat_at IS NOT NULL AND r.heartbeat_at < now() - interval '5 minutes') OR (r.heartbeat_at IS NULL AND r.started_at < now() - interval '5 minutes'))`
        const rows = (yield* sql`
          WITH candidate AS (
            SELECT id FROM discovery_runs
            WHERE state = 'QUEUED'
            ORDER BY queued_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE discovery_runs AS r
          SET state = 'RUNNING', started_at = COALESCE(started_at, now()), heartbeat_at = now()
          FROM candidate
          WHERE r.id = candidate.id AND r.state = 'QUEUED'
          RETURNING r.*`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeDiscoveryRun(r)
      }),
    heartbeat: (businessId: string, runId: string) =>
      // Guarded: heartbeats on terminal rows are ignored, never reopening them.
      sql`UPDATE discovery_runs SET heartbeat_at = now() WHERE id = ${runId} AND business_id = ${businessId} AND state = 'RUNNING'`.pipe(Effect.asVoid),
    setAuthorityDigest: (businessId: string, runId: string, digest: string) =>
      sql`UPDATE discovery_runs SET authority_snapshot_digest = ${digest} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid),
    incrementCounters: (businessId, runId, patch) =>
      Effect.gen(function*() {
        if (patch.pagesFetched !== undefined) yield* sql`UPDATE discovery_runs SET pages_fetched = pages_fetched + ${patch.pagesFetched} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid)
        if (patch.pagesNotModified !== undefined) yield* sql`UPDATE discovery_runs SET pages_not_modified = pages_not_modified + ${patch.pagesNotModified} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid)
        if (patch.pagesFailed !== undefined) yield* sql`UPDATE discovery_runs SET pages_failed = pages_failed + ${patch.pagesFailed} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid)
        if (patch.pagesSkippedRobots !== undefined) yield* sql`UPDATE discovery_runs SET pages_skipped_robots = pages_skipped_robots + ${patch.pagesSkippedRobots} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid)
        if (patch.bytesDownloaded !== undefined) yield* sql`UPDATE discovery_runs SET bytes_downloaded = bytes_downloaded + ${patch.bytesDownloaded} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid)
        if (patch.candidatesFound !== undefined) yield* sql`UPDATE discovery_runs SET candidates_found = candidates_found + ${patch.candidatesFound} WHERE id = ${runId} AND business_id = ${businessId}`.pipe(Effect.asVoid)
      }),
    markFinished: (businessId, runId, state, failureClass, failureDetailSafe) =>
      sql`UPDATE discovery_runs SET state = ${state}, completed_at = now(), failure_class = ${failureClass}, failure_detail_safe = ${failureDetailSafe} WHERE id = ${runId} AND business_id = ${businessId} AND state = 'RUNNING'`.pipe(Effect.asVoid),
  })),
)

// ---------------------------------------------------------------------------
// Frontier (durable per-URL queue)
// ---------------------------------------------------------------------------

export type DiscoveryFrontierState = "PENDING" | "IN_PROGRESS" | "DONE" | "SKIPPED"

export interface DiscoveryFrontierRow {
  readonly id: string
  readonly runId: string
  readonly businessId: string
  readonly canonicalUrl: string
  readonly requestedUrl: string
  readonly discoveredVia: string
  readonly parentUrl: string | null
  readonly depth: number
  readonly state: DiscoveryFrontierState
  readonly skipReason: string | null
  readonly orderKey: string
  readonly attempts: number
  readonly leaseAt: string | null
}

const DiscoveryFrontierSchema = Schema.Struct({
  id: UuidField,
  run_id: UuidField,
  business_id: UuidField,
  canonical_url: TextField,
  requested_url: TextField,
  discovered_via: TextField,
  parent_url: NullableTextField,
  depth: NullableIntField,
  state: TextField,
  skip_reason: NullableTextField,
  order_key: NullableTextField,
  attempts: NullableIntField,
  lease_at: NullableTimestampField,
})

const decodeFrontier = (r: unknown): Effect.Effect<DiscoveryFrontierRow, RowDecodeError> =>
  decodeRow(DiscoveryFrontierSchema, "discovery_frontier", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      runId: d.run_id,
      businessId: d.business_id,
      canonicalUrl: d.canonical_url,
      requestedUrl: d.requested_url,
      discoveredVia: d.discovered_via,
      parentUrl: d.parent_url,
      depth: Number(d.depth ?? 0),
      state: d.state as DiscoveryFrontierState,
      skipReason: d.skip_reason,
      orderKey: d.order_key ?? "",
      attempts: Number(d.attempts ?? 0),
      leaseAt: d.lease_at == null ? null : iso(d.lease_at),
    })),
  )

export interface DiscoveryFrontierEntry {
  readonly canonicalUrl: string
  readonly requestedUrl: string
  readonly discoveredVia: string
  readonly parentUrl?: string | null
  readonly depth?: number
  readonly orderKey: string
}

export interface DiscoveryObservationWrite {
  readonly scopeId: string
  readonly resourceKind: "ROBOTS" | "SITEMAP" | "PAGE"
  readonly requestedUrl: string
  readonly canonicalUrl: string
  readonly finalUrl: string
  readonly discoveredVia: string
  readonly parentUrl?: string | null
  readonly depth?: number
  readonly startedAt: string
  readonly completedAt: string
  readonly httpStatus?: number | null
  readonly contentType?: string | null
  readonly etag?: string | null
  readonly lastModified?: string | null
  readonly bodyDigest?: string | null
  readonly bodyBytes?: number
  readonly collectionState: "FETCHED" | "NOT_MODIFIED" | "FAILED"
  readonly failure?: string | null
}

export interface DiscoveryMatchWrite {
  readonly pageObservationId: string
  readonly lineageRootFactId: string
  readonly matchedFactId: string
  readonly matchedFactVersion: number
  readonly matchedValue: string
  readonly matchSurface: "JSON_LD" | "META" | "VISIBLE_TEXT"
  readonly evidenceLocator: string
  readonly evidenceSnippet: string
  readonly relationAtScan: "CURRENT_VALUE" | "HISTORICAL_VALUE"
  readonly matcherVersion: string
  /** Explicit reuse provenance: prior effective match this row reuses (304 carry-forward). */
  readonly reusedFromMatchId?: string | null
}

export class DiscoveryFrontierRepository extends Context.Tag("DiscoveryFrontierRepository")<
  DiscoveryFrontierRepository,
  {
    /** Insert entries; one row per canonical URL (re-inserts return 0 for dupes). Returns inserted count. */
    readonly enqueueMany: (input: { businessId: string; runId: string; entries: ReadonlyArray<DiscoveryFrontierEntry> }) => DbEffect<number>
    /** Oldest PENDING row -> IN_PROGRESS with a fresh lease, atomically. */
    readonly claimNext: (businessId: string, runId: string) => DbEffect<DiscoveryFrontierRow | null>
    /** IN_PROGRESS -> DONE. Terminal rows never reopen. */
    readonly markDone: (businessId: string, frontierId: string) => DbEffect<void>
    /** PENDING | IN_PROGRESS -> SKIPPED with a reason. */
    readonly markSkipped: (businessId: string, frontierId: string, reason: string) => DbEffect<void>
    readonly counts: (businessId: string, runId: string) => DbEffect<{ pending: number; inProgress: number; done: number; skipped: number }>
    /** SKIPPED rows grouped by reason (for honest skipped-page counts). */
    readonly skippedByReason: (businessId: string, runId: string) => DbEffect<ReadonlyArray<{ reason: string; count: number }>>
    /** Resume stale IN_PROGRESS rows (expired lease) back to PENDING. */
    readonly requeueStale: (businessId: string, runId: string) => DbEffect<number>
    /**
     * Atomic persist after a fetch performed OUTSIDE any transaction:
     * observation + matches + frontier DONE in one transaction.
     */
    readonly persistPageFetch: (input: {
      businessId: string
      frontierId: string
      observation: DiscoveryObservationWrite & { runId: string }
      matches: ReadonlyArray<Omit<DiscoveryMatchWrite, "pageObservationId">>
    }) => DbEffect<string>
    /** Insert pre-classified SKIPPED rows (robots/query skips are recorded, never fetched). */
    readonly insertSkipped: (input: {
      businessId: string
      runId: string
      entries: ReadonlyArray<DiscoveryFrontierEntry & { reason: string }>
    }) => DbEffect<number>
  }
>() {}

export const DiscoveryFrontierRepositoryLive = Layer.effect(
  DiscoveryFrontierRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    enqueueMany: (input) =>
      Effect.gen(function*() {
        let inserted = 0
        for (const e of input.entries) {
          const rows = (yield* sql`INSERT INTO discovery_frontier (run_id, business_id, canonical_url, requested_url, discovered_via, parent_url, depth, order_key) VALUES (${input.runId}, ${input.businessId}, ${e.canonicalUrl}, ${e.requestedUrl}, ${e.discoveredVia}, ${e.parentUrl ?? null}, ${e.depth ?? 0}, ${e.orderKey}) ON CONFLICT (run_id, canonical_url) DO NOTHING RETURNING id`) as Array<Record<string, unknown>>
          inserted += rows.length
        }
        return inserted
      }),
    claimNext: (businessId: string, runId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`
          UPDATE discovery_frontier AS f SET state = 'IN_PROGRESS', lease_at = now() + interval '5 minutes', attempts = attempts + 1
          WHERE f.id = (
            SELECT id FROM discovery_frontier
            WHERE run_id = ${runId} AND business_id = ${businessId} AND state = 'PENDING'
            ORDER BY order_key ASC, canonical_url ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          ) AND f.state = 'PENDING'
          RETURNING f.*`) as Array<unknown>
        const r = rows[0]
        if (!r) return null
        return yield* decodeFrontier(r)
      }),
    markDone: (businessId: string, frontierId: string) =>
      sql`UPDATE discovery_frontier SET state = 'DONE' WHERE id = ${frontierId} AND business_id = ${businessId} AND state = 'IN_PROGRESS'`.pipe(Effect.asVoid),
    markSkipped: (businessId: string, frontierId: string, reason: string) =>
      sql`UPDATE discovery_frontier SET state = 'SKIPPED', skip_reason = ${reason} WHERE id = ${frontierId} AND business_id = ${businessId} AND state IN ('PENDING','IN_PROGRESS')`.pipe(Effect.asVoid),
    counts: (businessId: string, runId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT state, count(*)::int AS n FROM discovery_frontier WHERE business_id = ${businessId} AND run_id = ${runId} GROUP BY state`) as Array<Record<string, unknown>>
        const counts = { pending: 0, inProgress: 0, done: 0, skipped: 0 }
        for (const r of rows) {
          const s = String(r["state"])
          const n = Number(r["n"] ?? 0)
          if (s === "PENDING") counts.pending = n
          else if (s === "IN_PROGRESS") counts.inProgress = n
          else if (s === "DONE") counts.done = n
          else if (s === "SKIPPED") counts.skipped = n
        }
        return counts
      }),
    skippedByReason: (businessId: string, runId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT skip_reason AS reason, count(*)::int AS n FROM discovery_frontier WHERE business_id = ${businessId} AND run_id = ${runId} AND state = 'SKIPPED' GROUP BY skip_reason`) as Array<Record<string, unknown>>
        return rows.map((r) => ({ reason: String(r["reason"] ?? "UNKNOWN"), count: Number(r["n"] ?? 0) }))
      }),
    requeueStale: (businessId: string, runId: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`UPDATE discovery_frontier SET state = 'PENDING', lease_at = NULL WHERE business_id = ${businessId} AND run_id = ${runId} AND state = 'IN_PROGRESS' AND lease_at IS NOT NULL AND lease_at < now() RETURNING id`) as Array<Record<string, unknown>>
        return rows.length
      }),
    persistPageFetch: (input) =>
      sql.withTransaction(
        Effect.gen(function*() {
          const o = input.observation
          const obsRows = (yield* sql`INSERT INTO discovery_observations (business_id, scope_id, run_id, resource_kind, requested_url, canonical_url, final_url, discovered_via, parent_url, depth, started_at, completed_at, http_status, content_type, etag, last_modified, body_digest, body_bytes, collection_state, failure) VALUES (${input.businessId}, ${o.scopeId}, ${o.runId}, ${o.resourceKind}, ${o.requestedUrl}, ${o.canonicalUrl}, ${o.finalUrl}, ${o.discoveredVia}, ${o.parentUrl ?? null}, ${o.depth ?? 0}, ${o.startedAt}::timestamptz, ${o.completedAt}::timestamptz, ${o.httpStatus ?? null}, ${o.contentType ?? null}, ${o.etag ?? null}, ${o.lastModified ?? null}, ${o.bodyDigest ?? null}, ${o.bodyBytes ?? 0}, ${o.collectionState}, ${o.failure ?? null}) RETURNING id`) as Array<unknown>
          const observationId = (yield* decodeRow(Schema.Struct({ id: UuidField }), "discovery_observations", obsRows[0])).id
          for (const m of input.matches) {
            yield* sql`INSERT INTO discovery_matches (business_id, run_id, page_observation_id, lineage_root_fact_id, matched_fact_id, matched_fact_version, matched_value, match_surface, evidence_locator, evidence_snippet, relation_at_scan, matcher_version, reused_from_match_id) VALUES (${input.businessId}, ${o.runId}, ${observationId}, ${m.lineageRootFactId}, ${m.matchedFactId}, ${m.matchedFactVersion}, ${m.matchedValue}, ${m.matchSurface}, ${m.evidenceLocator}, ${m.evidenceSnippet.slice(0, 512)}, ${m.relationAtScan}, ${m.matcherVersion}, ${m.reusedFromMatchId ?? null})`
          }
          yield* sql`UPDATE discovery_frontier SET state = 'DONE' WHERE id = ${input.frontierId} AND business_id = ${input.businessId} AND state = 'IN_PROGRESS'`
          return observationId
        }),
      ),
    insertSkipped: (input) =>
      Effect.gen(function*() {
        let inserted = 0
        for (const e of input.entries) {
          const rows = (yield* sql`INSERT INTO discovery_frontier (run_id, business_id, canonical_url, requested_url, discovered_via, parent_url, depth, state, skip_reason, order_key) VALUES (${input.runId}, ${input.businessId}, ${e.canonicalUrl}, ${e.requestedUrl}, ${e.discoveredVia}, ${e.parentUrl ?? null}, ${e.depth ?? 0}, 'SKIPPED', ${e.reason}, ${e.orderKey}) ON CONFLICT (run_id, canonical_url) DO NOTHING RETURNING id`) as Array<Record<string, unknown>>
          inserted += rows.length
        }
        return inserted
      }),
  })),
)

// ---------------------------------------------------------------------------
// Observations (append-only fetch evidence)
// ---------------------------------------------------------------------------

export interface DiscoveryObservationRow {
  readonly id: string
  readonly businessId: string
  readonly scopeId: string
  readonly runId: string
  readonly resourceKind: string
  readonly requestedUrl: string
  readonly canonicalUrl: string
  readonly finalUrl: string
  readonly discoveredVia: string
  readonly parentUrl: string | null
  readonly depth: number
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
  readonly createdAt: string
}

const DiscoveryObservationSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  scope_id: UuidField,
  run_id: UuidField,
  resource_kind: TextField,
  requested_url: TextField,
  canonical_url: TextField,
  final_url: TextField,
  discovered_via: TextField,
  parent_url: NullableTextField,
  depth: NullableIntField,
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
  created_at: TimestampField,
})

const decodeDiscoveryObservation = (r: unknown): Effect.Effect<DiscoveryObservationRow, RowDecodeError> =>
  decodeRow(DiscoveryObservationSchema, "discovery_observations", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      scopeId: d.scope_id,
      runId: d.run_id,
      resourceKind: d.resource_kind,
      requestedUrl: d.requested_url,
      canonicalUrl: d.canonical_url,
      finalUrl: d.final_url,
      discoveredVia: d.discovered_via,
      parentUrl: d.parent_url,
      depth: Number(d.depth ?? 0),
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
      createdAt: iso(d.created_at),
    })),
  )

export class DiscoveryObservationRepository extends Context.Tag("DiscoveryObservationRepository")<
  DiscoveryObservationRepository,
  {
    readonly insert: (input: DiscoveryObservationWrite & { businessId: string; runId: string }) => DbEffect<DiscoveryObservationRow>
    readonly listByRun: (businessId: string, runId: string) => DbEffect<ReadonlyArray<DiscoveryObservationRow>>
    /** Latest stored validators for a canonical URL within this scope (304 reuse). */
    readonly latestValidators: (
      businessId: string,
      scopeId: string,
      canonicalUrl: string,
    ) => DbEffect<{ etag: string | null; lastModified: string | null; authorityDigest: string | null; matcherVersion: string | null } | null>
  }
>() {}

export const DiscoveryObservationRepositoryLive = Layer.effect(
  DiscoveryObservationRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    insert: (input) =>
      Effect.gen(function*() {
        const rows = (yield* sql`INSERT INTO discovery_observations (business_id, scope_id, run_id, resource_kind, requested_url, canonical_url, final_url, discovered_via, parent_url, depth, started_at, completed_at, http_status, content_type, etag, last_modified, body_digest, body_bytes, collection_state, failure) VALUES (${input.businessId}, ${input.scopeId}, ${input.runId}, ${input.resourceKind}, ${input.requestedUrl}, ${input.canonicalUrl}, ${input.finalUrl}, ${input.discoveredVia}, ${input.parentUrl ?? null}, ${input.depth ?? 0}, ${input.startedAt}::timestamptz, ${input.completedAt}::timestamptz, ${input.httpStatus ?? null}, ${input.contentType ?? null}, ${input.etag ?? null}, ${input.lastModified ?? null}, ${input.bodyDigest ?? null}, ${input.bodyBytes ?? 0}, ${input.collectionState}, ${input.failure ?? null}) RETURNING *`) as Array<unknown>
        return yield* decodeDiscoveryObservation(rows[0])
      }),
    listByRun: (businessId: string, runId: string) =>
      sql`SELECT * FROM discovery_observations WHERE business_id = ${businessId} AND run_id = ${runId} ORDER BY created_at ASC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeDiscoveryObservation)),
      ),
    latestValidators: (businessId, scopeId, canonicalUrl) =>
      Effect.gen(function*() {
        const rows = (yield* sql`
          SELECT o.etag, o.last_modified, r.authority_snapshot_digest, r.matcher_version
          FROM discovery_observations o
          JOIN discovery_runs r ON r.id = o.run_id
          WHERE o.business_id = ${businessId} AND o.scope_id = ${scopeId} AND o.canonical_url = ${canonicalUrl}
            AND o.etag IS NOT NULL AND r.state IN ('SUCCEEDED','PARTIAL')
          ORDER BY o.completed_at DESC LIMIT 1`) as Array<Record<string, unknown>>
        const r = rows[0]
        if (!r) return null
        return {
          etag: (r["etag"] as string | null) ?? null,
          lastModified: (r["last_modified"] as string | null) ?? null,
          authorityDigest: (r["authority_snapshot_digest"] as string | null) ?? null,
          matcherVersion: (r["matcher_version"] as string | null) ?? null,
        }
      }),
  })),
)

// ---------------------------------------------------------------------------
// Matches (append-only match evidence)
// ---------------------------------------------------------------------------

export interface DiscoveryMatchRow {
  readonly id: string
  readonly businessId: string
  readonly runId: string
  readonly pageObservationId: string
  readonly lineageRootFactId: string
  readonly matchedFactId: string
  readonly matchedFactVersion: number
  readonly matchedValue: string
  readonly matchSurface: string
  readonly evidenceLocator: string
  readonly evidenceSnippet: string
  readonly relationAtScan: string
  readonly matcherVersion: string
  readonly reusedFromMatchId: string | null
  readonly createdAt: string
}

const DiscoveryMatchSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  run_id: UuidField,
  page_observation_id: UuidField,
  lineage_root_fact_id: UuidField,
  matched_fact_id: UuidField,
  matched_fact_version: IntField,
  matched_value: TextField,
  match_surface: TextField,
  evidence_locator: TextField,
  evidence_snippet: TextField,
  relation_at_scan: TextField,
  matcher_version: TextField,
  reused_from_match_id: NullableUuidField,
  created_at: TimestampField,
})

const decodeDiscoveryMatch = (r: unknown): Effect.Effect<DiscoveryMatchRow, RowDecodeError> =>
  decodeRow(DiscoveryMatchSchema, "discovery_matches", r).pipe(
    Effect.map((d) => ({
      id: d.id,
      businessId: d.business_id,
      runId: d.run_id,
      pageObservationId: d.page_observation_id,
      lineageRootFactId: d.lineage_root_fact_id,
      matchedFactId: d.matched_fact_id,
      matchedFactVersion: Number(d.matched_fact_version),
      matchedValue: d.matched_value,
      matchSurface: d.match_surface,
      evidenceLocator: d.evidence_locator,
      evidenceSnippet: d.evidence_snippet,
      relationAtScan: d.relation_at_scan,
      matcherVersion: d.matcher_version,
      reusedFromMatchId: d.reused_from_match_id,
      createdAt: iso(d.created_at),
    })),
  )

export class DiscoveryMatchRepository extends Context.Tag("DiscoveryMatchRepository")<
  DiscoveryMatchRepository,
  {
    readonly insertMany: (input: { businessId: string; runId: string; matches: ReadonlyArray<DiscoveryMatchWrite> }) => DbEffect<ReadonlyArray<DiscoveryMatchRow>>
    readonly listByRun: (businessId: string, runId: string) => DbEffect<ReadonlyArray<DiscoveryMatchRow>>
    /**
     * Previous effective (value-bearing) matches for one canonical page that
     * are compatible with a 304 carry-forward: same scope + URL, identical
     * authority digest + matcher version, from a terminal run. Newest run
     * first, so chained 304s reference the immediate prior (traceable hop
     * by hop). Empty when no compatible evidence exists: a 304 must never
     * invent a candidate.
     */
    readonly latestEffectiveMatches: (input: {
      businessId: string
      scopeId: string
      canonicalUrl: string
      authorityDigest: string
      matcherVersion: string
    }) => DbEffect<ReadonlyArray<DiscoveryMatchRow>>
  }
>() {}

export const DiscoveryMatchRepositoryLive = Layer.effect(
  DiscoveryMatchRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    insertMany: (input) =>
      Effect.gen(function*() {
        const out: DiscoveryMatchRow[] = []
        for (const m of input.matches) {
          const rows = (yield* sql`INSERT INTO discovery_matches (business_id, run_id, page_observation_id, lineage_root_fact_id, matched_fact_id, matched_fact_version, matched_value, match_surface, evidence_locator, evidence_snippet, relation_at_scan, matcher_version, reused_from_match_id) VALUES (${input.businessId}, ${input.runId}, ${m.pageObservationId}, ${m.lineageRootFactId}, ${m.matchedFactId}, ${m.matchedFactVersion}, ${m.matchedValue}, ${m.matchSurface}, ${m.evidenceLocator}, ${m.evidenceSnippet.slice(0, 512)}, ${m.relationAtScan}, ${m.matcherVersion}, ${m.reusedFromMatchId ?? null}) RETURNING *`) as Array<unknown>
          out.push(yield* decodeDiscoveryMatch(rows[0]))
        }
        return out
      }),
    listByRun: (businessId: string, runId: string) =>
      sql`SELECT * FROM discovery_matches WHERE business_id = ${businessId} AND run_id = ${runId} ORDER BY created_at ASC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows as Array<unknown>, decodeDiscoveryMatch)),
      ),
    latestEffectiveMatches: (input) =>
      Effect.gen(function*() {
        const rows = (yield* sql`
          SELECT m.* FROM discovery_matches m
          JOIN discovery_observations o ON o.id = m.page_observation_id
          JOIN discovery_runs r ON r.id = m.run_id
          WHERE m.business_id = ${input.businessId}
            AND o.scope_id = ${input.scopeId}
            AND o.canonical_url = ${input.canonicalUrl}
            AND r.authority_snapshot_digest = ${input.authorityDigest}
            AND m.matcher_version = ${input.matcherVersion}
            AND r.state IN ('SUCCEEDED','PARTIAL')
          ORDER BY r.completed_at DESC, m.created_at ASC`) as Array<unknown>
        if (rows.length === 0) return [] as ReadonlyArray<DiscoveryMatchRow>
        // Newest compatible run only: matches belong to one effective scan.
        const first = yield* decodeDiscoveryMatch(rows[0])
        const newestRun = first.runId
        const filtered = rows.filter((r) => (r as Record<string, unknown>)["run_id"] === newestRun || String((r as Record<string, unknown>)["run_id"]) === newestRun)
        return yield* Effect.forEach(filtered, decodeDiscoveryMatch)
      }),
  })),
)
