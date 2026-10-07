// Hosted re-collection tests: pure orchestration + stub-transport collector
// (no network), in-memory store (no DB server), plus a scratch-Postgres
// integration pass for the real SQL (skipped when scratch is unreachable).
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import type {
  CollectorOutcome,
  FetchResponse,
  HttpTransport,
  ObservedSourceValueV1,
  PreviousValidators,
  SourceBindingV1,
  SourceObservationV1,
  SourceTargetV1,
  WebCollector,
} from "@openrecord/representation"
import { NativeHttpCollector } from "@openrecord/representation"
import { migrate } from "./migrate.js"
import {
  collectSourceBinding,
  planRecollect,
  previousValidatorsFrom,
  recollectSourceBinding,
  type PreviousValueContext,
  type RecollectStore,
} from "./representation-collect.js"

const BIZ = "11111111-1111-4111-8111-111111111111"
const OTHER_BIZ = "22222222-2222-4222-8222-222222222222"
const TARGET_ID = "33333333-3333-4333-8333-333333333333"
const BINDING_ID = "44444444-4444-4444-8444-444444444444"
const FACT_ID = "55555555-5555-4555-8555-555555555555"
const URL = "http://example.test/pricing"
const T0 = "2026-10-04T10:00:00.000Z"
const T1 = "2026-10-04T11:00:00.000Z"

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")

const PRICE_HTML = (price: string): string =>
  `<!doctype html><html><head><title>Pricing</title></head><body><span class="price">${price}</span></body></html>`

const target = (businessId = BIZ): SourceTargetV1 => ({
  id: TARGET_ID,
  business_id: businessId,
  url: URL,
  control: "OWNED",
  enabled: true,
  created_at: T0,
})

const binding = (businessId = BIZ): SourceBindingV1 => ({
  id: BINDING_ID,
  business_id: businessId,
  fact_id: FACT_ID,
  source_target_id: TARGET_ID,
  extractor: { kind: "CSS_TEXT", selector: ".price" },
  comparator: "MONEY",
  created_at: T0,
})

const fetchedOutcome = (body: string, at = T1, extra?: Partial<CollectorOutcome["observation"]>): CollectorOutcome => ({
  observation: {
    collector: "NATIVE_HTTP",
    collector_version: "native-http/1",
    requested_url: URL,
    final_url: URL,
    started_at: at,
    completed_at: at,
    http_status: 200,
    content_type: "text/html",
    etag: '"v1"',
    last_modified: null,
    body_digest: sha(body),
    body_bytes: Buffer.byteLength(body),
    collection_state: "FETCHED",
    failure: null,
    raw_evidence_id: null,
    ...extra,
  },
  body,
  reusedDigest: null,
})

const notModifiedOutcome = (prev: PreviousValidators, at = T1): CollectorOutcome => ({
  observation: {
    collector: "NATIVE_HTTP",
    collector_version: "native-http/1",
    requested_url: URL,
    final_url: URL,
    started_at: at,
    completed_at: at,
    http_status: 304,
    content_type: null,
    etag: prev.etag,
    last_modified: prev.last_modified,
    body_digest: prev.body_digest,
    body_bytes: 0,
    collection_state: "NOT_MODIFIED",
    failure: null,
    raw_evidence_id: null,
  },
  body: null,
  reusedDigest: prev.body_digest,
})

const failedOutcome = (at = T1): CollectorOutcome => ({
  observation: {
    collector: "NATIVE_HTTP",
    collector_version: "native-http/1",
    requested_url: URL,
    final_url: URL,
    started_at: at,
    completed_at: at,
    http_status: null,
    content_type: null,
    etag: null,
    last_modified: null,
    body_digest: null,
    body_bytes: 0,
    collection_state: "FAILED",
    failure: "TIMEOUT",
    raw_evidence_id: null,
  },
  body: null,
  reusedDigest: null,
})

interface MemState {
  bindings: SourceBindingV1[]
  targets: SourceTargetV1[]
  facts: Array<{ id: string; value_text: string; business_id: string }>
  observations: SourceObservationV1[]
  values: ObservedSourceValueV1[]
  persistCalls: Array<{ observation: SourceObservationV1; value: ObservedSourceValueV1 | null }>
  collectCalls: Array<{ target: { id: string; business_id: string; url: string }; previous: PreviousValidators | null }>
}

const memStore = (state: MemState): RecollectStore => {
  const scoped = <T extends { business_id: string }>(rows: ReadonlyArray<T>, businessId: string): T[] =>
    rows.filter((r) => r.business_id === businessId)
  return {
    findBinding: (businessId, bindingId) =>
      Effect.succeed(scoped(state.bindings, businessId).find((b) => b.id === bindingId) ?? null),
    findTarget: (businessId, targetId) =>
      Effect.succeed(scoped(state.targets, businessId).find((t) => t.id === targetId) ?? null),
    findFactValue: (businessId, factId) => {
      const f = state.facts.find((x) => x.business_id === businessId && x.id === factId) ?? null
      return Effect.succeed(f === null ? null : { id: f.id, value_text: f.value_text })
    },
    latestObservation: (businessId, targetId) =>
      Effect.succeed(
        scoped(state.observations, businessId)
          .filter((o) => o.source_target_id === targetId)
          .sort((a, b) => a.completed_at.localeCompare(b.completed_at) || a.id.localeCompare(b.id))
          .at(-1) ?? null,
      ),
    latestValueContext: (businessId, bindingId) =>
      Effect.succeed(null as PreviousValueContext | null).pipe(
        Effect.map(() => {
          const v =
            scoped(state.values, businessId)
              .filter((x) => x.source_binding_id === bindingId)
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
              .at(-1) ?? null
          if (v === null) return null
          const obs = state.observations.find((o) => o.id === v.source_observation_id && o.business_id === businessId) ?? null
          return { value: v, digest: obs?.body_digest ?? null }
        }),
      ),
    persist: (observation, value) =>
      Effect.sync(() => {
        state.persistCalls.push({ observation, value })
        state.observations.push(observation)
        if (value !== null) state.values.push(value)
        return { observation, value }
      }),
  }
}

const blankState = (): MemState => ({ bindings: [], targets: [], facts: [], observations: [], values: [], persistCalls: [], collectCalls: [] })

const priorEvidence = (body: string, price: string, at = T0): { obs: SourceObservationV1; val: ObservedSourceValueV1 } => {
  const obs: SourceObservationV1 = {
    id: "66666666-6666-4666-8666-666666666666",
    business_id: BIZ,
    source_target_id: TARGET_ID,
    collector: "NATIVE_HTTP",
    collector_version: "native-http/1",
    requested_url: URL,
    final_url: URL,
    started_at: at,
    completed_at: at,
    http_status: 200,
    content_type: "text/html",
    etag: '"v1"',
    last_modified: null,
    body_digest: sha(body),
    body_bytes: Buffer.byteLength(body),
    collection_state: "FETCHED",
    failure: null,
    raw_evidence_id: null,
  }
  const val: ObservedSourceValueV1 = {
    id: "77777777-7777-4777-8777-777777777777",
    business_id: BIZ,
    source_observation_id: obs.id,
    source_binding_id: BINDING_ID,
    fact_id: FACT_ID,
    extracted_value: price,
    extraction_state: "OBSERVED",
    evidence_locator: { selector: ".price", source_observation_id: obs.id, node_identity: "css:.price" },
    extractor_version: "extractors/1",
    created_at: at,
  }
  return { obs, val }
}

const stubCollector = (state: MemState, outcome: CollectorOutcome): WebCollector => ({
  collect: async (t, previous) => {
    state.collectCalls.push({ target: { id: t.id, business_id: t.business_id, url: t.url }, previous: previous ?? null })
    return outcome
  },
})

const run = <A, E>(fx: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fx as Effect.Effect<A, E, never>)

describe("previousValidatorsFrom", () => {
  it("maps latest observation to conditional-GET validators, null when none", () => {
    expect(previousValidatorsFrom(null)).toBeNull()
    const { obs } = priorEvidence(PRICE_HTML("49 USD"), "49 USD")
    expect(previousValidatorsFrom(obs)).toEqual({
      etag: '"v1"',
      last_modified: null,
      body_digest: sha(PRICE_HTML("49 USD")),
      origin: "http://example.test",
    })
  })
})

describe("recollect with stub collector + in-memory store", () => {
  it("successful recollect persists observation + value, finding IN_SYNC", async () => {
    const state = blankState()
    state.bindings.push(binding())
    state.targets.push(target())
    state.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    const body = PRICE_HTML("49 USD")
    const out = await run(
      recollectSourceBinding(memStore(state), stubCollector(state, fetchedOutcome(body)), {
        businessId: BIZ,
        bindingId: BINDING_ID,
        observationId: "88888888-8888-4888-8888-888888888888",
        valueId: "99999999-9999-4999-8999-999999999999",
      }),
    )
    expect(out).not.toBeNull()
    expect(out?.observation.collection_state).toBe("FETCHED")
    expect(out?.observation.id).toBe("88888888-8888-4888-8888-888888888888")
    expect(out?.values).toHaveLength(1)
    expect(out?.values[0]).toMatchObject({ extracted_value: "49 USD", extraction_state: "OBSERVED", extractor_version: "extractors/1" })
    expect(out?.finding).toMatchObject({ state: "IN_SYNC", fact_id: FACT_ID, source_binding_id: BINDING_ID })
    // Single atomic persist carrying both rows; collector saw no validators.
    expect(state.persistCalls).toHaveLength(1)
    expect(state.collectCalls).toHaveLength(1)
    expect(state.collectCalls[0]?.previous).toBeNull()
  })

  it("passes previous validators to the collector", async () => {
    const body = PRICE_HTML("49 USD")
    const { obs, val } = priorEvidence(body, "49 USD")
    const state = blankState()
    state.bindings.push(binding())
    state.targets.push(target())
    state.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    state.observations.push(obs)
    state.values.push(val)
    const next = PRICE_HTML("49 USD")
    const out = await run(
      recollectSourceBinding(memStore(state), stubCollector(state, fetchedOutcome(next, T1, { etag: '"v2"', body_digest: sha(next) })), {
        businessId: BIZ,
        bindingId: BINDING_ID,
        observationId: randomUUID(),
        valueId: randomUUID(),
      }),
    )
    expect(state.collectCalls[0]?.previous).toEqual({
      etag: '"v1"',
      last_modified: null,
      body_digest: sha(body),
      origin: "http://example.test",
    })
    // Digest changed (etag v2 path keeps same body here? force a changed
    // digest): same body text means same digest -> reuse, no new value.
    expect(out?.values).toHaveLength(0)
    expect(out?.finding).toMatchObject({ state: "IN_SYNC", observed_value_id: val.id, source_observation_id: obs.id })
  })

  it("unchanged-digest FETCHED reuses extraction without a new value", async () => {
    const body = PRICE_HTML("49 USD")
    const { obs, val } = priorEvidence(body, "49 USD")
    const state = blankState()
    state.bindings.push(binding())
    state.targets.push(target())
    state.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    state.observations.push(obs)
    state.values.push(val)
    const out = await run(
      recollectSourceBinding(memStore(state), stubCollector(state, fetchedOutcome(body)), {
        businessId: BIZ,
        bindingId: BINDING_ID,
        observationId: randomUUID(),
        valueId: randomUUID(),
      }),
    )
    expect(out?.observation.collection_state).toBe("FETCHED")
    expect(out?.values).toHaveLength(0)
    expect(state.values).toHaveLength(1)
    expect(out?.finding).toMatchObject({ state: "IN_SYNC", observed_value_id: val.id })
  })

  it("changed digest extracts anew and can report DRIFT", async () => {
    const { obs, val } = priorEvidence(PRICE_HTML("49 USD"), "49 USD")
    const state = blankState()
    state.bindings.push(binding())
    state.targets.push(target())
    state.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    state.observations.push(obs)
    state.values.push(val)
    const out = await run(
      recollectSourceBinding(memStore(state), stubCollector(state, fetchedOutcome(PRICE_HTML("39 USD"))), {
        businessId: BIZ,
        bindingId: BINDING_ID,
        observationId: randomUUID(),
        valueId: randomUUID(),
      }),
    )
    expect(out?.values).toHaveLength(1)
    expect(out?.values[0]?.extracted_value).toBe("39 USD")
    expect(out?.finding).toMatchObject({ state: "DRIFT", reason: "observed differs from authority" })
    expect(state.values).toHaveLength(2)
  })

  it("304 reuses validators: new observation, no new values, prior finding kept", async () => {
    const body = PRICE_HTML("49 USD")
    const { obs, val } = priorEvidence(body, "49 USD")
    const state = blankState()
    state.bindings.push(binding())
    state.targets.push(target())
    state.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    state.observations.push(obs)
    state.values.push(val)
    const prev = previousValidatorsFrom(obs)
    const out = await run(
      recollectSourceBinding(memStore(state), stubCollector(state, notModifiedOutcome(prev!)), {
        businessId: BIZ,
        bindingId: BINDING_ID,
        observationId: randomUUID(),
        valueId: randomUUID(),
      }),
    )
    expect(out?.observation.collection_state).toBe("NOT_MODIFIED")
    expect(out?.values).toHaveLength(0)
    expect(state.values).toHaveLength(1)
    expect(out?.finding).toMatchObject({ state: "IN_SYNC", observed_value_id: val.id, source_observation_id: obs.id })
    expect(state.persistCalls).toHaveLength(1)
    expect(state.persistCalls[0]?.value).toBeNull()
  })

  it("failed fetch persists FAILED observation and never replaces prior evidence", async () => {
    const { obs, val } = priorEvidence(PRICE_HTML("49 USD"), "49 USD")
    const state = blankState()
    state.bindings.push(binding())
    state.targets.push(target())
    state.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    state.observations.push(obs)
    state.values.push(val)
    const out = await run(
      recollectSourceBinding(memStore(state), stubCollector(state, failedOutcome()), {
        businessId: BIZ,
        bindingId: BINDING_ID,
        observationId: randomUUID(),
        valueId: randomUUID(),
      }),
    )
    expect(out?.observation.collection_state).toBe("FAILED")
    expect(out?.observation.failure).toBe("TIMEOUT")
    expect(out?.values).toHaveLength(0)
    expect(state.values).toHaveLength(1)
    expect(state.values[0]).toMatchObject({ id: val.id, extracted_value: "49 USD" })
    // Effective finding still reflects the prior good evidence.
    expect(out?.finding).toMatchObject({ state: "IN_SYNC", observed_value_id: val.id })
  })

  it("failed fetch with no prior evidence is UNKNOWN (absence, not drift)", async () => {
    const state = blankState()
    state.bindings.push(binding())
    state.targets.push(target())
    state.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    const out = await run(
      recollectSourceBinding(memStore(state), stubCollector(state, failedOutcome()), {
        businessId: BIZ,
        bindingId: BINDING_ID,
        observationId: randomUUID(),
        valueId: randomUUID(),
      }),
    )
    expect(out?.observation.collection_state).toBe("FAILED")
    expect(out?.finding).toMatchObject({ state: "UNKNOWN" })
  })

  it("missing selector persists a NOT_FOUND value and reports UNKNOWN", async () => {
    const state = blankState()
    state.bindings.push({ ...binding(), extractor: { kind: "CSS_TEXT", selector: ".missing" } })
    state.targets.push(target())
    state.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    const out = await run(
      recollectSourceBinding(memStore(state), stubCollector(state, fetchedOutcome(PRICE_HTML("49 USD"))), {
        businessId: BIZ,
        bindingId: BINDING_ID,
        observationId: randomUUID(),
        valueId: randomUUID(),
      }),
    )
    expect(out?.values).toHaveLength(1)
    expect(out?.values[0]).toMatchObject({ extraction_state: "NOT_FOUND", extracted_value: null })
    expect(out?.finding).toMatchObject({ state: "UNKNOWN", reason: "selector found no value" })
  })

  it("cross-tenant binding is invisible: null, no collect, no persist", async () => {
    const state = blankState()
    state.bindings.push(binding())
    state.targets.push(target())
    state.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    const out = await run(
      recollectSourceBinding(memStore(state), stubCollector(state, fetchedOutcome(PRICE_HTML("49 USD"))), {
        businessId: OTHER_BIZ,
        bindingId: BINDING_ID,
        observationId: randomUUID(),
        valueId: randomUUID(),
      }),
    )
    expect(out).toBeNull()
    expect(state.collectCalls).toHaveLength(0)
    expect(state.persistCalls).toHaveLength(0)
  })

  it("missing binding, target, or fact each read as null", async () => {
    const full = blankState()
    full.bindings.push(binding())
    full.targets.push(target())
    full.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    const noBinding = blankState()
    noBinding.targets.push(target())
    noBinding.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    const noTarget = blankState()
    noTarget.bindings.push(binding())
    noTarget.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    const noFact = blankState()
    noFact.bindings.push(binding())
    noFact.targets.push(target())
    for (const s of [noBinding, noTarget, noFact]) {
      const out = await run(
        recollectSourceBinding(memStore(s), stubCollector(s, fetchedOutcome(PRICE_HTML("49 USD"))), {
          businessId: BIZ,
          bindingId: BINDING_ID,
          observationId: randomUUID(),
          valueId: randomUUID(),
        }),
      )
      expect(out).toBeNull()
      expect(s.collectCalls).toHaveLength(0)
      expect(s.persistCalls).toHaveLength(0)
    }
    void full
  })
})

describe("real NativeHttpCollector with stub transport (no network)", () => {
  // Stub transport serves one page with an ETag and honors If-None-Match,
  // proving conditional-GET reuse through the production collector path.
  const stubTransport = (seen: Array<Record<string, string>>, body: string): HttpTransport => ({
    lookup: async () => ["93.184.216.34"],
    fetch: async (_url, init): Promise<FetchResponse> => {
      seen.push({ ...init.headers })
      if (init.headers["if-none-match"] === '"v1"') {
        return { status: 304, headers: {}, body: null, peerIp: "93.184.216.34" }
      }
      return {
        status: 200,
        headers: { "content-type": "text/html", etag: '"v1"' },
        body: new TextEncoder().encode(body),
        peerIp: "93.184.216.34",
      }
    },
  })

  it("FETCHED then 304: validators sent, no new values, finding stays IN_SYNC", async () => {
    const state = blankState()
    state.bindings.push(binding())
    state.targets.push(target())
    state.facts.push({ id: FACT_ID, value_text: "49 USD", business_id: BIZ })
    const store = memStore(state)
    const seen: Array<Record<string, string>> = []
    const collector = new NativeHttpCollector({ transport: stubTransport(seen, PRICE_HTML("49 USD")) })
    const first = await run(
      recollectSourceBinding(store, collector, {
        businessId: BIZ,
        bindingId: BINDING_ID,
        observationId: "aaaaaaa0-0000-4000-8000-000000000001",
        valueId: "bbbbbbb0-0000-4000-8000-000000000001",
      }),
    )
    expect(first?.observation.collection_state).toBe("FETCHED")
    expect(first?.values).toHaveLength(1)
    expect(first?.finding.state).toBe("IN_SYNC")
    expect(seen[0]?.["if-none-match"]).toBeUndefined()
    const second = await run(
      recollectSourceBinding(store, collector, {
        businessId: BIZ,
        bindingId: BINDING_ID,
        observationId: "aaaaaaa0-0000-4000-8000-000000000002",
        valueId: "bbbbbbb0-0000-4000-8000-000000000002",
      }),
    )
    // Conditional GET carried the validator from the first observation.
    expect(seen[1]?.["if-none-match"]).toBe('"v1"')
    expect(second?.observation.collection_state).toBe("NOT_MODIFIED")
    expect(second?.values).toHaveLength(0)
    expect(state.values).toHaveLength(1)
    expect(second?.finding).toMatchObject({
      state: "IN_SYNC",
      observed_value_id: "bbbbbbb0-0000-4000-8000-000000000001",
      source_observation_id: "aaaaaaa0-0000-4000-8000-000000000001",
    })
  })

  it("planRecollect derives DRIFT/UNKNOWN through existing evaluate semantics", () => {
    const b = binding()
    const fact = { id: FACT_ID, value_text: "49 USD" }
    const drift = planRecollect({
      binding: b,
      fact,
      outcome: fetchedOutcome(PRICE_HTML("39 USD")),
      previousValidators: null,
      previousValue: null,
      ids: { observationId: randomUUID(), valueId: randomUUID() },
    })
    expect(drift.finding.state).toBe("DRIFT")
    const missing = planRecollect({
      binding: { ...b, extractor: { kind: "CSS_TEXT", selector: ".nope" } },
      fact,
      outcome: fetchedOutcome(PRICE_HTML("49 USD")),
      previousValidators: null,
      previousValue: null,
      ids: { observationId: randomUUID(), valueId: randomUUID() },
    })
    expect(missing.finding).toMatchObject({ state: "UNKNOWN" })
  })
})

// ---------------------------------------------------------------------------
// Scratch-Postgres integration (real SQL, stub transport, no network).
// ---------------------------------------------------------------------------

const SCRATCH = process.env["OPENRECORD_SCRATCH_URL"] ?? "postgres://wira@localhost:5432/openrecord_scratch"

let scratchUp = false
try {
  const probe = new pg.Pool({ connectionString: SCRATCH, connectionTimeoutMillis: 2000 })
  await probe.query("SELECT 1")
  await probe.end()
  scratchUp = true
} catch {
  scratchUp = false
}

const runPg = scratchUp ? describe : describe.skip

runPg("postgres representation re-collection", () => {
  let pool: pg.Pool
  let scope: Scope.CloseableScope
  let ctx: Context.Context<PgClient.PgClient>
  const runFx = <A, E>(fx: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> => Effect.runPromise(Effect.provide(fx, ctx))

  const unique = (prefix: string): string => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

  const setupBusiness = async (): Promise<{ businessId: string; factId: string; targetId: string; bindingId: string }> => {
    const accountId = String((await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"])
    const businessId = String((await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Recollect') RETURNING id`, [accountId])).rows[0]["id"])
    const factId = String(
      (
        await pool.query(
          `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, valid_from, source_kind) VALUES ($1,'Acme Starter','monthly price','49 USD','CURRENCY','ACTIVE',1,'2026-01-01T00:00:00Z','MANUAL') RETURNING id`,
          [businessId],
        )
      ).rows[0]["id"],
    )
    const targetId = String(
      (await pool.query(`INSERT INTO source_targets (business_id, url, control) VALUES ($1,'http://example.test/pricing','OWNED') RETURNING id`, [businessId])).rows[0]["id"],
    )
    const bindingId = String(
      (
        await pool.query(
          `INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator) VALUES ($1,$2,$3,'CSS_TEXT','.price','MONEY') RETURNING id`,
          [businessId, factId, targetId],
        )
      ).rows[0]["id"],
    )
    return { businessId, factId, targetId, bindingId }
  }

  const priceTransport = (seen: Array<Record<string, string>>): HttpTransport => ({
    lookup: async () => ["93.184.216.34"],
    fetch: async (_url, init): Promise<FetchResponse> => {
      seen.push({ ...init.headers })
      if (init.headers["if-none-match"] === '"page-v1"') {
        return { status: 304, headers: {}, body: null, peerIp: "93.184.216.34" }
      }
      return {
        status: 200,
        headers: { "content-type": "text/html", etag: '"page-v1"' },
        body: new TextEncoder().encode(PRICE_HTML("49 USD")),
        peerIp: "93.184.216.34",
      }
    },
  })

  beforeAll(async () => {
    await migrate(SCRATCH)
    pool = new pg.Pool({ connectionString: SCRATCH })
    scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(PgClient.layer({ url: Redacted.make(SCRATCH) }), scope))
  })
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await pool.end()
  })

  it("persists observation + value, then reuses on 304", async () => {
    const { businessId, targetId, bindingId } = await setupBusiness()
    const seen: Array<Record<string, string>> = []
    const first = await runFx(collectSourceBinding(businessId, bindingId, priceTransport(seen)))
    expect(first?.observation.collection_state).toBe("FETCHED")
    expect(first?.values).toHaveLength(1)
    expect(first?.values[0]).toMatchObject({ extracted_value: "49 USD", extraction_state: "OBSERVED" })
    expect(first?.finding.state).toBe("IN_SYNC")
    const obs1 = (await pool.query(`SELECT count(*)::int AS n FROM source_observations WHERE source_target_id = $1`, [targetId])).rows[0]["n"]
    const val1 = (await pool.query(`SELECT count(*)::int AS n FROM observed_source_values WHERE source_binding_id = $1`, [bindingId])).rows[0]["n"]
    expect(obs1).toBe(1)
    expect(val1).toBe(1)
    const second = await runFx(collectSourceBinding(businessId, bindingId, priceTransport(seen)))
    expect(seen[1]?.["if-none-match"]).toBe('"page-v1"')
    expect(second?.observation.collection_state).toBe("NOT_MODIFIED")
    expect(second?.values).toHaveLength(0)
    expect(second?.finding).toMatchObject({ state: "IN_SYNC", observed_value_id: first?.values[0]?.id })
    const obs2 = (await pool.query(`SELECT count(*)::int AS n FROM source_observations WHERE source_target_id = $1`, [targetId])).rows[0]["n"]
    const val2 = (await pool.query(`SELECT count(*)::int AS n FROM observed_source_values WHERE source_binding_id = $1`, [bindingId])).rows[0]["n"]
    expect(obs2).toBe(2)
    expect(val2).toBe(1)
  })

  it("failed fetch persists FAILED and keeps prior evidence; cross-tenant reads null", async () => {
    const { businessId, targetId, bindingId } = await setupBusiness()
    const seen: Array<Record<string, string>> = []
    const first = await runFx(collectSourceBinding(businessId, bindingId, priceTransport(seen)))
    expect(first?.finding.state).toBe("IN_SYNC")
    const failing: HttpTransport = {
      lookup: async () => {
        throw new Error("dns down")
      },
      fetch: async () => {
        throw new Error("unreachable")
      },
    }
    const failed = await runFx(collectSourceBinding(businessId, bindingId, failing))
    expect(failed?.observation.collection_state).toBe("FAILED")
    expect(failed?.values).toHaveLength(0)
    expect(failed?.finding).toMatchObject({ state: "IN_SYNC", observed_value_id: first?.values[0]?.id })
    const valCount = (await pool.query(`SELECT count(*)::int AS n FROM observed_source_values WHERE source_binding_id = $1`, [bindingId])).rows[0]["n"]
    expect(valCount).toBe(1)
    const states = (
      await pool.query(`SELECT collection_state FROM source_observations WHERE source_target_id = $1 ORDER BY completed_at ASC`, [targetId])
    ).rows.map((r) => r["collection_state"])
    expect(states).toEqual(["FETCHED", "FAILED"])
    // Cross-tenant: a different business sees nothing, writes nothing.
    const otherAccount = String((await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("acct")])).rows[0]["id"])
    const otherBiz = String((await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Other') RETURNING id`, [otherAccount])).rows[0]["id"])
    const cross = await runFx(collectSourceBinding(otherBiz, bindingId, priceTransport(seen)))
    expect(cross).toBeNull()
    const obsAfter = (await pool.query(`SELECT count(*)::int AS n FROM source_observations WHERE source_target_id = $1`, [targetId])).rows[0]["n"]
    expect(obsAfter).toBe(2)
  })
})
