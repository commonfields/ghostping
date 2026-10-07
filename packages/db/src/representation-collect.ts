// Hosted source re-collection for one SourceBinding (Effect, PostgreSQL).
//
// ASSAY SUMMARY (read-only findings that shape this module):
// - There is NO callable hosted collection service. `collectAndEvaluate`
//   (packages/representation/src/service.ts) is pure orchestration over an
//   injected `RepresentationStore` + `WebCollector`: it is synchronous (no
//   queue), takes an explicit target + bindings, and has no binding/target
//   resolution, no tenant scoping, and no router exposure.
// - `packages/db/src/representation.ts` provides ONLY
//   SourceTargetRepository{create,listByBusiness} and
//   SourceObservationRepository{create,latestByTarget,historyByTarget}. There
//   are no insertObservation/insertValue/latestObservation/
//   previousValueForDigest store methods anywhere in packages/db: binding
//   reads live in product.ts (ProductReadRepository.binding, read-only),
//   value writes/reads and fact reads have no repository at all. This module
//   therefore adds SQL ONLY for those gaps (binding/target/fact reads,
//   latest-value context, observation+value insert); the observation insert
//   mirrors SourceObservationRepository.create's column list exactly.
// - Validators are reused from the latest observation for the target
//   ({etag, last_modified, body_digest, origin: originOf(final_url)}); the
//   collector sends If-None-Match/If-Modified-Since same-origin only, and a
//   304 yields a NOT_MODIFIED observation with body null and the reused
//   digest. Values are persisted only for FETCHED bodies with a changed
//   digest (shouldReuseExtraction), via EXTRACTOR_VERSION ("extractors/1")
//   extractors; findings are derived by deriveFinding, with effective.ts
//   walking back across 304/unchanged reuse so FAILED never replaces prior
//   evidence.
//
// Capability: resolve one binding tenant-scoped, collect over the network
// OUTSIDE any DB transaction via the injected WebCollector (default
// NativeHttpCollector: SSRF protection, byte limits, timeouts, conditional
// GET exactly as in collector.ts/safe-http.ts), then persist the
// SourceObservation + its bound ObservedSourceValue in ONE transaction.
// Returns null (404-style) for missing or cross-tenant bindings/targets/
// facts, never leaking cross-tenant existence.
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import {
  deriveFinding,
  EXTRACTOR_VERSION,
  extractCssText,
  extractJsonLd,
  extractMetaContent,
  NativeHttpCollector,
  originOf,
  shouldReuseExtraction,
} from "@openrecord/representation"
import type {
  CollectorOutcome,
  HttpTransport,
  ObservedSourceValueV1,
  PreviousValidators,
  RepresentationFindingV1,
  SourceBindingV1,
  SourceObservationV1,
  SourceTargetV1,
  WebCollector,
} from "@openrecord/representation"
import {
  BooleanField,
  decodeRow,
  NullableIntField,
  NullableTextField,
  NullableUuidField,
  RowDecodeError,
  TextField,
  TimestampField,
  UuidField,
} from "./row-codecs.js"

const iso = (v: unknown): string => new Date(String(v)).toISOString()

// ---------------------------------------------------------------------------
// Row decoders (table shapes mirror product.ts; this module maps them to the
// representation V1 domain instead of the product read rows).
// ---------------------------------------------------------------------------

const BindingSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  fact_id: UuidField,
  source_target_id: UuidField,
  extractor_kind: TextField,
  extractor_selector: TextField,
  comparator: TextField,
  created_at: TimestampField,
})

const decodeBinding = (r: unknown): Effect.Effect<SourceBindingV1 | null, RowDecodeError> =>
  decodeRow(BindingSchema, "source_bindings", r).pipe(
    Effect.map((d): SourceBindingV1 | null => {
      if (d.extractor_kind !== "JSON_LD" && d.extractor_kind !== "CSS_TEXT" && d.extractor_kind !== "META_CONTENT") return null
      if (d.comparator !== "EXACT_TEXT" && d.comparator !== "BOOLEAN" && d.comparator !== "MONEY") return null
      return {
        id: d.id,
        business_id: d.business_id,
        fact_id: d.fact_id,
        source_target_id: d.source_target_id,
        extractor: { kind: d.extractor_kind, selector: d.extractor_selector },
        comparator: d.comparator,
        created_at: iso(d.created_at),
      }
    }),
  )

const TargetSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  url: TextField,
  control: TextField,
  enabled: BooleanField,
  created_at: TimestampField,
})

const decodeTarget = (r: unknown): Effect.Effect<SourceTargetV1 | null, RowDecodeError> =>
  decodeRow(TargetSchema, "source_targets", r).pipe(
    Effect.map((d): SourceTargetV1 | null => {
      if (d.control !== "OWNED" && d.control !== "THIRD_PARTY" && d.control !== "UNKNOWN") return null
      return {
        id: d.id,
        business_id: d.business_id,
        url: d.url,
        control: d.control,
        enabled: d.enabled,
        created_at: iso(d.created_at),
      }
    }),
  )

const ObservationSchema = Schema.Struct({
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
  raw_evidence_id: NullableUuidField,
})

const decodeObservation = (r: unknown): Effect.Effect<SourceObservationV1 | null, RowDecodeError> =>
  decodeRow(ObservationSchema, "source_observations", r).pipe(
    Effect.map((d): SourceObservationV1 | null => {
      if (d.collector !== "NATIVE_HTTP" && d.collector !== "PLAYWRIGHT" && d.collector !== "FIRECRAWL") return null
      if (d.collection_state !== "FETCHED" && d.collection_state !== "NOT_MODIFIED" && d.collection_state !== "FAILED") return null
      const failure = d.failure as SourceObservationV1["failure"]
      if (failure !== null && failure !== "TIMEOUT" && failure !== "REDIRECT_LIMIT" && failure !== "RESPONSE_TOO_LARGE" && failure !== "UNSUPPORTED_CONTENT_TYPE" && failure !== "NETWORK_ERROR" && failure !== "SECURITY_REJECTED" && failure !== "INVALID_URL") {
        return null
      }
      return {
        id: d.id,
        business_id: d.business_id,
        source_target_id: d.source_target_id,
        collector: d.collector,
        collector_version: d.collector_version,
        requested_url: d.requested_url,
        final_url: d.final_url,
        started_at: iso(d.started_at),
        completed_at: iso(d.completed_at),
        http_status: d.http_status === null ? null : Number(d.http_status),
        content_type: d.content_type,
        etag: d.etag,
        last_modified: d.last_modified,
        body_digest: d.body_digest,
        body_bytes: Number(d.body_bytes ?? 0),
        collection_state: d.collection_state,
        failure,
        raw_evidence_id: d.raw_evidence_id,
      }
    }),
  )

const ValueSchema = Schema.Struct({
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

const decodeValue = (r: unknown): Effect.Effect<ObservedSourceValueV1 | null, RowDecodeError> =>
  decodeRow(ValueSchema, "observed_source_values", r).pipe(
    Effect.map((d): ObservedSourceValueV1 | null => {
      if (d.extraction_state !== "OBSERVED" && d.extraction_state !== "NOT_FOUND" && d.extraction_state !== "AMBIGUOUS" && d.extraction_state !== "UNSUPPORTED" && d.extraction_state !== "FAILED") {
        return null
      }
      return {
        id: d.id,
        business_id: d.business_id,
        source_observation_id: d.source_observation_id,
        source_binding_id: d.source_binding_id,
        fact_id: d.fact_id,
        extracted_value: d.extracted_value,
        extraction_state: d.extraction_state,
        evidence_locator: {
          selector: d.evidence_selector,
          source_observation_id: d.evidence_observation_id,
          node_identity: d.evidence_node_identity,
        },
        extractor_version: d.extractor_version,
        created_at: iso(d.created_at),
      }
    }),
  )

const FactValueSchema = Schema.Struct({ id: UuidField, value_text: TextField })

// ---------------------------------------------------------------------------
// Pure decision core (no I/O): previous validators, extraction dispatch
// (same switch as service.ts runExtractor), reuse, and finding derivation.
// ---------------------------------------------------------------------------

/** Latest observation -> conditional-GET validators (same mapping as collectAndEvaluate). */
export const previousValidatorsFrom = (latest: SourceObservationV1 | null): PreviousValidators | null =>
  latest === null
    ? null
    : { etag: latest.etag, last_modified: latest.last_modified, body_digest: latest.body_digest, origin: originOf(latest.final_url) }

const runBindingExtractor = (binding: SourceBindingV1, html: string) => {
  switch (binding.extractor.kind) {
    case "JSON_LD":
      return extractJsonLd(html, binding.extractor.selector)
    case "CSS_TEXT":
      return extractCssText(html, binding.extractor.selector)
    case "META_CONTENT":
      return extractMetaContent(html, binding.extractor.selector)
  }
}

export interface PreviousValueContext {
  /** Newest extracted value for this binding (effective evidence carried forward across 304s). */
  readonly value: ObservedSourceValueV1
  /** Body digest of the observation that produced it (reuse comparison anchor). */
  readonly digest: string | null
}

/**
 * Pure outcome planning: observation fields (ids supplied by the caller),
 * an optional single bound value, and the EFFECTIVE finding (effective.ts
 * walk-back semantics: 304/unchanged/FAILED attempts without a new value
 * keep the prior effective value and its observation anchor, so failure
 * never replaces prior evidence; no prior value -> UNKNOWN).
 */
export const planRecollect = (args: {
  readonly binding: SourceBindingV1
  readonly fact: { readonly id: string; readonly value_text: string }
  readonly outcome: CollectorOutcome
  readonly previousValidators: PreviousValidators | null
  readonly previousValue: PreviousValueContext | null
  readonly ids: { readonly observationId: string; readonly valueId: string }
}): { readonly observation: SourceObservationV1; readonly value: ObservedSourceValueV1 | null; readonly finding: RepresentationFindingV1 } => {
  const observation: SourceObservationV1 = {
    id: args.ids.observationId,
    business_id: args.binding.business_id,
    source_target_id: args.binding.source_target_id,
    ...args.outcome.observation,
  }
  const effectiveFallback = {
    observationId: args.previousValue?.value.source_observation_id ?? observation.id,
    value: args.previousValue?.value ?? null,
  }
  if (args.outcome.body === null) {
    return { observation, value: null, finding: deriveFinding(args.fact, args.binding, effectiveFallback.observationId, effectiveFallback.value) }
  }
  const reuse = shouldReuseExtraction({
    collection_state: observation.collection_state,
    body_digest: observation.body_digest,
    previous_digest: args.previousValue?.digest ?? args.previousValidators?.body_digest ?? null,
    extractor_version: EXTRACTOR_VERSION,
    previous_extractor_version: args.previousValue?.value.extractor_version ?? null,
    comparator_unchanged: true,
  })
  if (reuse) {
    return { observation, value: null, finding: deriveFinding(args.fact, args.binding, effectiveFallback.observationId, effectiveFallback.value) }
  }
  const r = runBindingExtractor(args.binding, args.outcome.body)
  const value: ObservedSourceValueV1 = {
    id: args.ids.valueId,
    business_id: args.binding.business_id,
    source_observation_id: observation.id,
    source_binding_id: args.binding.id,
    fact_id: args.binding.fact_id,
    extracted_value: r.value,
    extraction_state: r.state,
    evidence_locator: {
      selector: args.binding.extractor.selector,
      source_observation_id: observation.id,
      node_identity: r.node_identity,
    },
    extractor_version: EXTRACTOR_VERSION,
    created_at: observation.completed_at,
  }
  return { observation, value, finding: deriveFinding(args.fact, args.binding, observation.id, value) }
}

// ---------------------------------------------------------------------------
// Injectable store boundary (Effect). Reads are tenant-scoped (business_id
// on every query; miss -> null). persist writes observation + value in ONE
// transaction (PgClient.withTransaction in the PG implementation).
// ---------------------------------------------------------------------------

export type RecollectError = SqlError | RowDecodeError

export interface RecollectStore {
  readonly findBinding: (businessId: string, bindingId: string) => Effect.Effect<SourceBindingV1 | null, RecollectError>
  readonly findTarget: (businessId: string, targetId: string) => Effect.Effect<SourceTargetV1 | null, RecollectError>
  readonly findFactValue: (businessId: string, factId: string) => Effect.Effect<{ readonly id: string; readonly value_text: string } | null, RecollectError>
  readonly latestObservation: (businessId: string, targetId: string) => Effect.Effect<SourceObservationV1 | null, RecollectError>
  readonly latestValueContext: (businessId: string, bindingId: string) => Effect.Effect<PreviousValueContext | null, RecollectError>
  readonly persist: (observation: SourceObservationV1, value: ObservedSourceValueV1 | null) => Effect.Effect<{ readonly observation: SourceObservationV1; readonly value: ObservedSourceValueV1 | null }, RecollectError>
}

export interface CollectSourceBindingResult {
  readonly observation: SourceObservationV1
  readonly values: ReadonlyArray<ObservedSourceValueV1>
  readonly finding: RepresentationFindingV1
}

/**
 * Orchestration: tenant-scoped reads -> network collection (OUTSIDE any DB
 * transaction) -> single-transaction persist. Returns null 404-style when
 * the binding, its target, or its fact is missing or belongs to another
 * business. The collector is injected (tests pass a stub WebCollector or a
 * NativeHttpCollector with a stub transport); no second collector, no
 * global fetch, no browser/proxy anywhere on this path.
 */
export const recollectSourceBinding = (
  store: RecollectStore,
  collector: WebCollector,
  input: { readonly businessId: string; readonly bindingId: string; readonly observationId: string; readonly valueId: string },
): Effect.Effect<CollectSourceBindingResult | null, RecollectError> =>
  Effect.gen(function*() {
    const binding = yield* store.findBinding(input.businessId, input.bindingId)
    if (binding === null) return null
    const target = yield* store.findTarget(input.businessId, binding.source_target_id)
    if (target === null) return null
    const fact = yield* store.findFactValue(input.businessId, binding.fact_id)
    if (fact === null) return null
    const latest = yield* store.latestObservation(input.businessId, target.id)
    const previousValidators = previousValidatorsFrom(latest)
    const previousValue = yield* store.latestValueContext(input.businessId, binding.id)
    // Network I/O happens here, between the reads and the write
    // transaction: no DB transaction is open across the fetch.
    const outcome = yield* Effect.promise(() =>
      collector.collect({ id: target.id, business_id: input.businessId, url: target.url }, previousValidators),
    )
    const planned = planRecollect({
      binding,
      fact,
      outcome,
      previousValidators,
      previousValue,
      ids: { observationId: input.observationId, valueId: input.valueId },
    })
    const persisted = yield* store.persist(planned.observation, planned.value)
    const values = persisted.value === null ? [] : [persisted.value]
    // Finding derives from the persisted rows (same ids the plan used), so
    // the returned finding always matches stored evidence.
    const effective = persisted.value ?? previousValue?.value ?? null
    const finding = deriveFinding(
      fact,
      binding,
      persisted.value !== null ? persisted.observation.id : (effective?.source_observation_id ?? persisted.observation.id),
      effective,
    )
    return { observation: persisted.observation, values, finding }
  })

/** PostgreSQL RecollectStore over an @effect/sql client. Every read filters by business_id. */
export const pgRecollectStore = (sql: SqlClient.SqlClient): RecollectStore => ({
  findBinding: (businessId, bindingId) =>
    Effect.gen(function*() {
      const rows = (yield* sql`SELECT * FROM source_bindings WHERE id = ${bindingId} AND business_id = ${businessId}`) as Array<unknown>
      const r = rows[0]
      if (!r) return null
      return yield* decodeBinding(r)
    }),
  findTarget: (businessId, targetId) =>
    Effect.gen(function*() {
      const rows = (yield* sql`SELECT * FROM source_targets WHERE id = ${targetId} AND business_id = ${businessId}`) as Array<unknown>
      const r = rows[0]
      if (!r) return null
      return yield* decodeTarget(r)
    }),
  findFactValue: (businessId, factId) =>
    Effect.gen(function*() {
      // Any status: a binding may legitimately point at a superseded or
      // retired version. Tenancy is the only filter.
      const rows = (yield* sql`SELECT id, value_text FROM authoritative_facts WHERE id = ${factId} AND business_id = ${businessId}`) as Array<unknown>
      const r = rows[0]
      if (!r) return null
      const d = yield* decodeRow(FactValueSchema, "authoritative_facts", r)
      return { id: d.id, value_text: d.value_text }
    }),
  latestObservation: (businessId, targetId) =>
    Effect.gen(function*() {
      const rows = (yield* sql`SELECT * FROM source_observations WHERE source_target_id = ${targetId} AND business_id = ${businessId} ORDER BY completed_at DESC, id DESC LIMIT 1`) as Array<unknown>
      const r = rows[0]
      if (!r) return null
      return yield* decodeObservation(r)
    }),
  latestValueContext: (businessId, bindingId) =>
    Effect.gen(function*() {
      const rows = (yield* sql`
        SELECT v.*, o.body_digest AS value_observation_digest FROM observed_source_values v
        JOIN source_observations o ON o.id = v.source_observation_id
        WHERE v.source_binding_id = ${bindingId} AND v.business_id = ${businessId}
        ORDER BY v.created_at DESC LIMIT 1`) as Array<unknown>
      const r = rows[0]
      if (!r) return null
      const value = yield* decodeValue(r)
      if (value === null) return null
      const digest = (r as Record<string, unknown>)["value_observation_digest"]
      return { value, digest: typeof digest === "string" ? digest : null }
    }),
  persist: (observation, value) =>
    sql.withTransaction(
      Effect.gen(function*() {
        // Column list mirrors SourceObservationRepository.create (plus the
        // explicit id); raw_evidence_id is always null on this path.
        const obsRows = (yield* sql`INSERT INTO source_observations (id, business_id, source_target_id, collector, collector_version, requested_url, final_url, started_at, completed_at, http_status, content_type, etag, last_modified, body_digest, body_bytes, collection_state, failure) VALUES (${observation.id}, ${observation.business_id}, ${observation.source_target_id}, ${observation.collector}, ${observation.collector_version}, ${observation.requested_url}, ${observation.final_url}, ${observation.started_at}::timestamptz, ${observation.completed_at}::timestamptz, ${observation.http_status}, ${observation.content_type}, ${observation.etag}, ${observation.last_modified}, ${observation.body_digest}, ${observation.body_bytes}, ${observation.collection_state}, ${observation.failure}) RETURNING *`) as Array<unknown>
        const persistedObs = yield* decodeObservation(obsRows[0])
        if (persistedObs === null) return yield* Effect.fail(new RowDecodeError({ table: "source_observations", detail: "insert did not decode" }))
        if (value === null) return { observation: persistedObs, value: null as ObservedSourceValueV1 | null }
        // Satisfies the tenancy trigger: shared business_id and
        // evidence_observation_id = source_observation_id.
        const valRows = (yield* sql`INSERT INTO observed_source_values (id, business_id, source_observation_id, source_binding_id, fact_id, extracted_value, extraction_state, evidence_selector, evidence_observation_id, evidence_node_identity, extractor_version, created_at) VALUES (${value.id}, ${value.business_id}, ${value.source_observation_id}, ${value.source_binding_id}, ${value.fact_id}, ${value.extracted_value}, ${value.extraction_state}, ${value.evidence_locator.selector}, ${value.evidence_locator.source_observation_id}, ${value.evidence_locator.node_identity}, ${value.extractor_version}, ${value.created_at}::timestamptz) RETURNING *`) as Array<unknown>
        const persistedVal = yield* decodeValue(valRows[0])
        if (persistedVal === null) return yield* Effect.fail(new RowDecodeError({ table: "observed_source_values", detail: "insert did not decode" }))
        return { observation: persistedObs, value: persistedVal as ObservedSourceValueV1 | null }
      }),
    ),
})

/**
 * Hosted capability: re-collect one SourceBinding. Resolves binding ->
 * target -> fact -> previous validators tenant-scoped (null on any miss,
 * including cross-tenant), collects with NativeHttpCollector (injected
 * transport override for tests; default production transport otherwise),
 * and persists observation + value atomically.
 */
export const collectSourceBinding = (
  businessId: string,
  bindingId: string,
  transport?: HttpTransport,
): Effect.Effect<CollectSourceBindingResult | null, RecollectError, PgClient.PgClient> =>
  Effect.gen(function*() {
    const sql = yield* PgClient.PgClient
    const collector = new NativeHttpCollector(transport !== undefined ? { transport } : {})
    return yield* recollectSourceBinding(pgRecollectStore(sql), collector, {
      businessId,
      bindingId,
      observationId: randomUUID(),
      valueId: randomUUID(),
    })
  })

export class RepresentationCollectService extends Context.Tag("RepresentationCollectService")<
  RepresentationCollectService,
  {
    readonly collectSourceBinding: (
      businessId: string,
      bindingId: string,
      transport?: HttpTransport,
    ) => Effect.Effect<CollectSourceBindingResult | null, RecollectError, PgClient.PgClient>
  }
>() {}

export const RepresentationCollectServiceLive = Layer.succeed(RepresentationCollectService, { collectSourceBinding })
