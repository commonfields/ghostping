// Operator-driven source tracking: tenancy, validation, idempotent
// re-tracking, and proof that discovery-style flows never auto-create.
// DB-free: stubbed Effect layers, mirroring interventions.test.ts.
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  BusinessRepository,
  FactRepository,
  ProductReadRepository,
  SourceTargetRepository,
} from "@ghostping/db"
import { createBinding, createTarget } from "./tracking.js"

const BIZ_A = "11111111-1111-4111-8111-111111111111"
const BIZ_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const TARGET_A = "33333333-3333-4333-8333-333333333333"
const FACT_A = "44444444-4444-4444-8444-444444444444"

const BusinessStub = Layer.succeed(BusinessRepository, {
  create: () => Effect.dieMessage("unused"),
  list: () => Effect.succeed([]),
  getScoped: (_accountId: string, _id: string) => Effect.succeed(null),
})

const makeTargets = () => {
  const rows: Array<{ id: string; businessId: string; url: string; control: string; enabled: boolean; createdAt: string }> = []
  let n = 0
  const service = {
    create: (input: { businessId: string; url: string; control: string }) =>
      Effect.sync(() => {
        n += 1
        const row = { id: `50000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, enabled: true, createdAt: "2026-10-01T00:00:00.000Z", ...input }
        rows.push(row)
        return row
      }),
    listByBusiness: (businessId: string) => Effect.succeed(rows.filter((r) => r.businessId === businessId)),
    getScoped: (businessId: string, id: string) =>
      Effect.succeed(rows.find((r) => r.businessId === businessId && r.id === id) ?? null),
  }
  return { rows, service, layer: Layer.succeed(SourceTargetRepository, service) }
}

const FactStub = Layer.succeed(FactRepository, {
  create: () => Effect.dieMessage("unused"),
  listByBusiness: () => Effect.succeed([]),
  getScoped: (businessId: string, id: string) =>
    Effect.succeed(
      businessId === BIZ_A && id === FACT_A
        ? {
          id: FACT_A, businessId: BIZ_A, subject: "acme", predicate: "monthly_price", valueText: "49 USD",
          valueType: "CURRENCY", status: "ACTIVE", version: 1, supersedesId: null,
          validFrom: "2026-10-01T00:00:00.000Z", validUntil: null, sourceKind: "MANUAL",
          createdAt: "2026-10-01T00:00:00.000Z",
        }
        : null,
    ),
  supersede: () => Effect.dieMessage("unused"),
  retire: () => Effect.succeed(null),
  activeOverlapping: () => Effect.succeed([]),
})

const makeReads = () => {
  const bindings: Array<{ key: string; row: { id: string } }> = []
  let n = 0
  const service = {
    findBindingExact: (businessId: string, targetId: string, factId: string) =>
      Effect.succeed(bindings.find((b) => b.key === `${businessId}:${targetId}:${factId}`)?.row ?? null),
    createBinding: (input: { businessId: string; factId: string; sourceTargetId: string }) =>
      Effect.sync(() => {
        n += 1
        const row = { id: `60000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}` }
        bindings.push({ key: `${input.businessId}:${input.sourceTargetId}:${input.factId}`, row })
        return row as never
      }),
  }
  return { bindings, service, layer: Layer.succeed(ProductReadRepository, service as never) }
}

describe("createTarget", () => {
  it("creates an owned target with a canonical URL", async () => {
    const targets = makeTargets()
    const env = Layer.mergeAll(BusinessStub, targets.layer)
    const created = await Effect.runPromise(
      createTarget(BIZ_A, { url: "https://acme.example/pricing/", control: "OWNED" }).pipe(Effect.provide(env)),
    )
    expect(created?.url).toBe("https://acme.example/pricing")
    expect(created?.control).toBe("OWNED")
  })

  it("rejects non-http URLs without persisting", async () => {
    const targets = makeTargets()
    const env = Layer.mergeAll(BusinessStub, targets.layer)
    expect(await Effect.runPromise(createTarget(BIZ_A, { url: "ftp://acme.example/x", control: "OWNED" }).pipe(Effect.provide(env)))).toBeNull()
    expect(await Effect.runPromise(createTarget(BIZ_A, { url: "javascript:alert(1)", control: "OWNED" }).pipe(Effect.provide(env)))).toBeNull()
    expect(targets.rows).toHaveLength(0)
  })

  it("re-tracking the same URL returns the existing row", async () => {
    const targets = makeTargets()
    const env = Layer.mergeAll(BusinessStub, targets.layer)
    const first = await Effect.runPromise(createTarget(BIZ_A, { url: "https://acme.example/pricing", control: "OWNED" }).pipe(Effect.provide(env)))
    const second = await Effect.runPromise(createTarget(BIZ_A, { url: "https://acme.example/pricing/", control: "OWNED" }).pipe(Effect.provide(env)))
    expect(second?.id).toBe(first?.id)
    expect(targets.rows).toHaveLength(1)
  })
})

describe("createBinding", () => {
  it("binds an approved fact to a tracked target", async () => {
    const targets = makeTargets()
    const reads = makeReads()
    const env = Layer.mergeAll(BusinessStub, targets.layer, FactStub, reads.layer)
    await Effect.runPromise(createTarget(BIZ_A, { url: "https://acme.example/pricing", control: "OWNED" }).pipe(Effect.provide(env)))
    const targetId = targets.rows[0]!.id
    const binding = await Effect.runPromise(
      createBinding(BIZ_A, targetId, { factId: FACT_A, extractorKind: "CSS_TEXT", extractorSelector: ".price", comparator: "MONEY" }).pipe(
        Effect.provide(env),
      ),
    )
    expect(binding).not.toBeNull()
  })

  it("unknown or cross-business targets and facts read as null", async () => {
    const targets = makeTargets()
    const reads = makeReads()
    const env = Layer.mergeAll(BusinessStub, targets.layer, FactStub, reads.layer)
    const input = { factId: FACT_A, extractorKind: "CSS_TEXT" as const, extractorSelector: ".price", comparator: "MONEY" as const }
    expect(await Effect.runPromise(createBinding(BIZ_A, TARGET_A, input).pipe(Effect.provide(env)))).toBeNull()
    expect(await Effect.runPromise(createBinding(BIZ_B, TARGET_A, input).pipe(Effect.provide(env)))).toBeNull()
    expect(await Effect.runPromise(
      createBinding(BIZ_A, TARGET_A, { ...input, factId: "99999999-9999-4999-8999-999999999999" }).pipe(Effect.provide(env)),
    )).toBeNull()
    expect(reads.bindings).toHaveLength(0)
  })

  it("identical re-tracking returns the existing binding", async () => {
    const targets = makeTargets()
    const reads = makeReads()
    const env = Layer.mergeAll(BusinessStub, targets.layer, FactStub, reads.layer)
    await Effect.runPromise(createTarget(BIZ_A, { url: "https://acme.example/pricing", control: "OWNED" }).pipe(Effect.provide(env)))
    const targetId = targets.rows[0]!.id
    const input = { factId: FACT_A, extractorKind: "CSS_TEXT" as const, extractorSelector: ".price", comparator: "MONEY" as const }
    const first = await Effect.runPromise(createBinding(BIZ_A, targetId, input).pipe(Effect.provide(env)))
    const second = await Effect.runPromise(createBinding(BIZ_A, targetId, input).pipe(Effect.provide(env)))
    expect(second).toEqual(first)
    expect(reads.bindings).toHaveLength(1)
  })
})
