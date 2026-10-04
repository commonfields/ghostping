import { describe, expect, it } from "vitest"
import { Schema } from "effect"

describe("HTTP request schemas reject malformed payloads", () => {
  it("fact value types are closed enums", async () => {
    const contracts = await import("./index.js")
    const bad = {
      subject: "s", predicate: "p", valueText: "$39",
      valueType: "MONEY", validFrom: "2026-01-01T00:00:00Z", sourceKind: "MANUAL",
    }
    expect(Schema.decodeUnknownEither(contracts.CreateFactRequest)(bad)._tag).toBe("Left")
    const badOrigin = { prompt: "hi", origin: "BOSS" }
    expect(Schema.decodeUnknownEither(contracts.CreateQuestionRequest)(badOrigin)._tag).toBe("Left")
    const badVerdict = { claimId: "00000000-0000-4000-8000-000000000000", verdict: "WRONG", factIds: [] }
    expect(Schema.decodeUnknownEither(contracts.CreateJudgmentRequest)(badVerdict)._tag).toBe("Left")
    const badIds = { claimId: "not-a-uuid", verdict: "SUPPORTED", factIds: "x" }
    expect(Schema.decodeUnknownEither(contracts.CreateJudgmentRequest)(badIds)._tag).toBe("Left")
    const good = { claimId: "00000000-0000-4000-8000-000000000000", verdict: "SUPPORTED", factIds: [] }
    expect(Schema.decodeUnknownEither(contracts.CreateJudgmentRequest)(good)._tag).toBe("Right")
  })

  it("rejects malformed timestamps, nulls, missing fields, non-array factIds", async () => {
    const contracts = await import("./index.js")
    const base = {
      subject: "northstar", predicate: "monthly_price", valueText: "$39",
      valueType: "CURRENCY", validFrom: "2026-01-01T00:00:00Z", sourceKind: "MANUAL",
    }
    expect(Schema.decodeUnknownEither(contracts.CreateFactRequest)(base)._tag).toBe("Right")
    expect(Schema.decodeUnknownEither(contracts.CreateFactRequest)({ ...base, validFrom: "not-a-date" })._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(contracts.CreateFactRequest)({ ...base, validUntil: "yesterday-ish" })._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(contracts.CreateFactRequest)({ ...base, valueText: null })._tag).toBe("Left")
    const { subject: _drop, ...missing } = base
    expect(Schema.decodeUnknownEither(contracts.CreateFactRequest)(missing)._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(contracts.CreateFactRequest)({ ...base, valueType: 42 })._tag).toBe("Left")
  })
})
