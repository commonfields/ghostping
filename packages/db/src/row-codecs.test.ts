import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import {
  IntField,
  NullableTextField,
  TextField,
  TimestampField,
  UuidField,
  decodeRow,
  RowDecodeError,
} from "./row-codecs.js"

// Representative per-table shape (mirrors businesses + a version int like
// authoritative_facts): validates through Schema.Struct first, then maps
// with the same iso()/Number() semantics as the repository mappers.
const BusinessLike = Schema.Struct({
  id: UuidField,
  account_id: UuidField,
  name: TextField,
  created_at: TimestampField,
})

const FactLike = Schema.Struct({
  id: UuidField,
  version: IntField,
  label: NullableTextField,
})

const run = <A>(eff: Effect.Effect<A, RowDecodeError>) => Effect.runPromiseExit(eff)

describe("row-codecs DB boundary", () => {
  it("decodes a valid row with identical value semantics", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174000"
    const acct = "123e4567-e89b-12d3-a456-426614174001"
    const exit = await run(decodeRow(BusinessLike, "businesses", { id, account_id: acct, name: "Northstar", created_at: new Date("2026-01-01T00:00:00.000Z") }))
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.id).toBe(id)
      expect(exit.value.name).toBe("Northstar")
    }
    // Ints arrive as number|string from pg: both validate, Number() after.
    for (const version of [3, "3"]) {
      const v = await run(decodeRow(FactLike, "authoritative_facts", { id, version, label: null }))
      expect(v._tag).toBe("Success")
      if (v._tag === "Success") expect(Number(v.value.version)).toBe(3)
    }
  })

  it("a corrupt row (wrong types) fails as RowDecodeError instead of String()/Number() coercion", async () => {
    // Old unchecked code would have produced id "42", name "null", NaN, etc.
    const corrupt = { id: 42, account_id: null, name: null, created_at: true }
    const exit = await run(decodeRow(BusinessLike, "businesses", corrupt))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(RowDecodeError)
      expect(exit.cause.error.table).toBe("businesses")
      expect(exit.cause.error.detail.length).toBeGreaterThan(0)
    }
    // Wrong int type (boolean) must fail, not become Number(true) === 1.
    const badInt = await run(
      decodeRow(FactLike, "authoritative_facts", { id: "123e4567-e89b-12d3-a456-426614174000", version: true, label: null }),
    )
    expect(badInt._tag).toBe("Failure")
    if (badInt._tag === "Failure" && badInt.cause._tag === "Fail") {
      expect(badInt.cause.error).toBeInstanceOf(RowDecodeError)
    }
  })

  it("a row missing a required field fails as RowDecodeError instead of silent null", async () => {
    const missing = { id: "123e4567-e89b-12d3-a456-426614174000", account_id: "123e4567-e89b-12d3-a456-426614174001" }
    const exit = await run(decodeRow(BusinessLike, "businesses", missing))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(RowDecodeError)
      expect(exit.cause.error.table).toBe("businesses")
    }
  })
})
