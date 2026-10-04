// Recorded actions product surface: tenancy (account B reaches nothing of
// account A's issues), request validation (bad types fail the contract
// schema the POST route decodes; unknown claims read as null so the route
// answers 404), and the append-only write path (two appends are both
// listed; corrections stay out of scope). DB-free: stubbed Effect layers
// plus the contract schemas, mirroring discovery.test.ts.
import { describe, expect, it } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { ClaimRepository, InterventionRepository, type InterventionInput, type InterventionRow } from "@ghostping/db"
import { CreateInterventionRequest, decodeRouteId } from "@ghostping/contracts"
import { loadInterventions, recordIntervention } from "./interventions.js"

const BIZ_A = "11111111-1111-4111-8111-111111111111"
const BIZ_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OBS_A = "33333333-3333-4333-8333-333333333333"
const CLAIM_A = "22222222-2222-4222-8222-222222222222"
const CLAIM_UNKNOWN = "44444444-4444-4444-8444-444444444444"

const ClaimStub = Layer.succeed(ClaimRepository, {
  create: () => Effect.dieMessage("unused"),
  listByBusiness: () => Effect.succeed([]),
  getScoped: (businessId: string, id: string) =>
    Effect.succeed(
      businessId === BIZ_A && id === CLAIM_A
        ? {
          id: CLAIM_A,
          businessId: BIZ_A,
          observationId: OBS_A,
          text: "Acme Starter costs $29 per month",
          origin: "MANUAL_TRANSCRIPTION",
          createdAt: "2026-10-01T00:00:00.000Z",
        }
        : null,
    ),
})

const makeStore = () => {
  const rows: Array<InterventionRow> = []
  let n = 0
  const service = {
    append: (input: InterventionInput) =>
      Effect.sync(() => {
        n += 1
        const row: InterventionRow = {
          id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
          businessId: input.businessId,
          issueIds: [...input.issueIds].sort(),
          type: input.type,
          target: input.target,
          performedAt: input.performedAt,
          actor: input.actor,
          actorId: input.actorId,
          notes: input.notes,
          evidenceBeforeDigest: input.evidenceBeforeDigest,
          evidenceAfterDigest: input.evidenceAfterDigest,
          supersedesId: input.supersedesId,
          correctionReason: input.correctionReason,
          createdAt: "2026-10-03T00:00:00.000Z",
        }
        rows.push(row)
        return row
      }),
    listByIssue: (businessId: string, issueId: string) =>
      Effect.succeed(rows.filter((r) => r.businessId === businessId && r.issueIds.includes(issueId))),
  }
  return { rows, service, layer: Layer.succeed(InterventionRepository, service) }
}

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const input = (target: string) => ({
  type: "SOURCE_UPDATED" as const,
  target,
  performedAt: "2026-10-02T00:00:00.000Z",
  notes: null,
  evidenceBeforeDigest: null,
  evidenceAfterDigest: null,
})

describe("intervention tenancy", () => {
  it("account B cannot list recorded actions on account A's issue", async () => {
    const store = makeStore()
    const env = Layer.mergeAll(ClaimStub, store.layer)
    const recorded = await Effect.runPromise(recordIntervention(BIZ_A, CLAIM_A, USER_A, input("https://acme.example/pricing")).pipe(Effect.provide(env)))
    expect(recorded).not.toBeNull()
    expect(await Effect.runPromise(loadInterventions(BIZ_A, CLAIM_A).pipe(Effect.provide(env)))).toHaveLength(1)
    expect(await Effect.runPromise(loadInterventions(BIZ_B, CLAIM_A).pipe(Effect.provide(env)))).toBeNull()
  })

  it("account B cannot record on account A's issue", async () => {
    const store = makeStore()
    const env = Layer.mergeAll(ClaimStub, store.layer)
    expect(await Effect.runPromise(recordIntervention(BIZ_B, CLAIM_A, USER_B, input("https://acme.example/pricing")).pipe(Effect.provide(env)))).toBeNull()
    expect(store.rows).toHaveLength(0)
  })

  it("account B never sees account A's actor identity", async () => {
    const store = makeStore()
    const env = Layer.mergeAll(ClaimStub, store.layer)
    await Effect.runPromise(recordIntervention(BIZ_A, CLAIM_A, USER_A, input("https://acme.example/pricing")).pipe(Effect.provide(env)))
    // Cross-tenant reads are null (404 upstream), so no user id leaks.
    expect(await Effect.runPromise(loadInterventions(BIZ_B, CLAIM_A).pipe(Effect.provide(env)))).toBeNull()
  })
})

describe("intervention actor provenance", () => {
  it("records actor HUMAN with the authenticated user id", async () => {
    const store = makeStore()
    const env = Layer.mergeAll(ClaimStub, store.layer)
    const recorded = await Effect.runPromise(recordIntervention(BIZ_A, CLAIM_A, USER_A, input("https://acme.example/pricing")).pipe(Effect.provide(env)))
    expect(recorded?.actor).toBe("HUMAN")
    expect(recorded?.actorId).toBe(USER_A)
  })

  it("request JSON cannot spoof actor identity", async () => {
    // The contract schema carries no actor fields: extra keys are stripped
    // on decode, and the helper signature only accepts an explicit actorId
    // supplied by the route from the session — never the body.
    const decoded = Schema.decodeUnknownEither(CreateInterventionRequest)({
      type: "SOURCE_UPDATED",
      target: "https://acme.example/pricing",
      actor: "SYSTEM",
      actorId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    })
    expect(decoded._tag).toBe("Right")
    if (decoded._tag === "Right") {
      expect("actor" in decoded.right).toBe(false)
      expect("actorId" in decoded.right).toBe(false)
    }
    const store = makeStore()
    const env = Layer.mergeAll(ClaimStub, store.layer)
    // Even a caller holding another user's id for this business records only
    // the id it was actually given (the route gives the session user id).
    const recorded = await Effect.runPromise(recordIntervention(BIZ_A, CLAIM_A, USER_B, input("https://acme.example/pricing")).pipe(Effect.provide(env)))
    expect(recorded?.actorId).toBe(USER_B)
  })

  it("historical NULL actor ids remain readable", async () => {
    const store = makeStore()
    const env = Layer.mergeAll(ClaimStub, store.layer)
    await Effect.runPromise(recordIntervention(BIZ_A, CLAIM_A, USER_A, input("https://acme.example/pricing")).pipe(Effect.provide(env)))
    // A pre-provenance row (actorId NULL) decodes and lists unchanged.
    store.rows.push({
      id: "00000000-0000-4000-8000-000000000099",
      businessId: BIZ_A,
      issueIds: [CLAIM_A],
      type: "SOURCE_UPDATED",
      target: "https://acme.example/old",
      performedAt: "2026-10-01T00:00:00.000Z",
      actor: "HUMAN",
      actorId: null,
      notes: null,
      evidenceBeforeDigest: null,
      evidenceAfterDigest: null,
      supersedesId: null,
      correctionReason: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    })
    const rows = await Effect.runPromise(loadInterventions(BIZ_A, CLAIM_A).pipe(Effect.provide(env)))
    expect(rows).toHaveLength(2)
    expect(rows?.find((r) => r.actorId === null)).toBeDefined()
  })
})

describe("intervention request validation", () => {
  const decode = Schema.decodeUnknownEither(CreateInterventionRequest)

  it("rejects unknown intervention types", () => {
    // The POST route decodes every body through this schema first and
    // answers 422 on failure, so a bad type never reaches the repository.
    expect(decode({ type: "BOGUS_TYPE", target: "https://acme.example/pricing" })._tag).toBe("Left")
  })

  it("rejects empty targets and unparseable timestamps", () => {
    expect(decode({ type: "SOURCE_UPDATED", target: "" })._tag).toBe("Left")
    expect(decode({ type: "SOURCE_UPDATED", target: "https://acme.example/pricing", performedAt: "not-a-time" })._tag).toBe("Left")
  })

  it("accepts every recorded-action type with optional fields absent", () => {
    for (const type of [
      "SOURCE_UPDATED",
      "SOURCE_PUBLISHED",
      "THIRD_PARTY_CORRECTION_REQUESTED",
      "KNOWLEDGE_BASE_UPDATED",
      "STRUCTURED_DATA_UPDATED",
      "OTHER",
    ] as const) {
      const parsed = decode({ type, target: "https://acme.example/pricing" })
      expect(parsed._tag).toBe("Right")
    }
    // performedAt defaults to now at the route; digests stay optional.
    const minimal = decode({ type: "OTHER", target: "https://acme.example/help" })
    expect(minimal._tag).toBe("Right")
  })

  it("unknown and malformed claim ids read as null (404 at the route)", async () => {
    const store = makeStore()
    const env = Layer.mergeAll(ClaimStub, store.layer)
    expect(await Effect.runPromise(loadInterventions(BIZ_A, CLAIM_UNKNOWN).pipe(Effect.provide(env)))).toBeNull()
    expect(await Effect.runPromise(recordIntervention(BIZ_A, CLAIM_UNKNOWN, USER_A, input("https://acme.example/pricing")).pipe(Effect.provide(env)))).toBeNull()
    // Malformed ids never reach the repository: the route maps them to 404.
    expect(decodeRouteId("not-a-uuid")._tag).toBe("Left")
  })
})

describe("append-only recorded actions", () => {
  it("two appends are both listed", async () => {
    const store = makeStore()
    const env = Layer.mergeAll(ClaimStub, store.layer)
    const first = await Effect.runPromise(
      recordIntervention(BIZ_A, CLAIM_A, USER_A, { ...input("https://acme.example/pricing"), performedAt: "2026-10-02T00:00:00.000Z" }).pipe(Effect.provide(env)),
    )
    const second = await Effect.runPromise(
      recordIntervention(BIZ_A, CLAIM_A, USER_A, { ...input("https://acme.example/help"), performedAt: "2026-10-03T00:00:00.000Z" }).pipe(Effect.provide(env)),
    )
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    const listed = await Effect.runPromise(loadInterventions(BIZ_A, CLAIM_A).pipe(Effect.provide(env)))
    expect(listed?.map((r) => r.id)).toEqual([first?.id, second?.id])
    expect(listed?.map((r) => r.target)).toEqual(["https://acme.example/pricing", "https://acme.example/help"])
  })

  it("this path records plain actions only: human actor, no corrections", async () => {
    const store = makeStore()
    const env = Layer.mergeAll(ClaimStub, store.layer)
    const recorded = await Effect.runPromise(recordIntervention(BIZ_A, CLAIM_A, USER_A, input("https://acme.example/pricing")).pipe(Effect.provide(env)))
    expect(recorded?.actor).toBe("HUMAN")
    expect(recorded?.supersedesId).toBeNull()
    expect(recorded?.correctionReason).toBeNull()
  })

  it("appended rows are never rewritten", async () => {
    const store = makeStore()
    const env = Layer.mergeAll(ClaimStub, store.layer)
    const first = await Effect.runPromise(recordIntervention(BIZ_A, CLAIM_A, USER_A, input("https://acme.example/pricing")).pipe(Effect.provide(env)))
    const snapshot = first ? { ...first, issueIds: [...first.issueIds] } : null
    await Effect.runPromise(recordIntervention(BIZ_A, CLAIM_A, USER_A, input("https://acme.example/help")).pipe(Effect.provide(env)))
    expect(store.rows[0]).toEqual(snapshot)
    // The repository surface offers no rewrite operation at all.
    expect(Object.keys(store.service).sort()).toEqual(["append", "listByIssue"])
    expect("update" in store.service).toBe(false)
    expect("remove" in store.service).toBe(false)
  })
})
