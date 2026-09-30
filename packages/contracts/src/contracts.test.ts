// Cross-language worker-contract fixtures: the SAME golden JSON files under
// tests/worker-contract/ must decode in TypeScript (Effect Schema) and Rust
// (serde). No codegen in V1 — compatibility testing only.
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  WorkerJobV1,
  WorkerResultV1,
  decodeWorkerJob,
  decodeWorkerResult,
  encodeWorkerResult,
} from "./index.js"

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tests", "worker-contract")
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8"))

const decodeEither = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknownEither(schema)(value)

describe("worker-contract golden fixtures", () => {
  it("valid job fixture decodes in TS", () => {
    const parsed = decodeEither(WorkerJobV1, fixture("job-v1.valid.json"))
    expect(parsed._tag).toBe("Right")
    if (parsed._tag === "Right") {
      expect(parsed.right.contract_version).toBe("ghostping-worker-job-v1")
      expect(parsed.right.run_id).toBe("RUN-FIXTURE-1")
      expect(parsed.right).toEqual(decodeWorkerJob(fixture("job-v1.valid.json")))
    }
  })

  it("valid success result fixture decodes in TS", () => {
    const parsed = decodeEither(WorkerResultV1, fixture("result-v1.success.json"))
    expect(parsed._tag).toBe("Right")
    if (parsed._tag === "Right") {
      expect(parsed.right.status).toBe("succeeded")
      expect(parsed.right.answer_text).toContain("$29")
      expect(parsed.right).toEqual(decodeWorkerResult(fixture("result-v1.success.json")))
    }
  })

  it("valid failure result fixture decodes in TS", () => {
    const parsed = decodeEither(WorkerResultV1, fixture("result-v1.failure.json"))
    expect(parsed._tag).toBe("Right")
    if (parsed._tag === "Right") {
      expect(parsed.right.status).toBe("failed")
      expect(parsed.right.failure_class).toBe("PROVIDER_UNAVAILABLE")
    }
  })

  it("9router success result shares result-v1 (no version bump)", () => {
    const parsed = decodeEither(WorkerResultV1, fixture("result-v1.9router.json"))
    expect(parsed._tag).toBe("Right")
    if (parsed._tag === "Right") {
      expect(parsed.right.provider).toBe("9router")
      expect(parsed.right.requested_model).toBe("oc/pinned-free-test")
      expect(parsed.right.observed_model).toBe("oc/pinned-free-test")
      expect(parsed.right.retrieval_mode).toBe("unknown")
      expect(parsed.right.citations).toEqual([])
      const raw = parsed.right.raw_response as Record<string, unknown>
      expect((raw["usage"] as Record<string, unknown>)["total_tokens"]).toBe(30)
    }
  })

  it("TS output encodes back into the fixture shape", () => {
    const decoded = decodeWorkerResult(fixture("result-v1.success.json"))
    const encoded = encodeWorkerResult(decoded) as Record<string, unknown>
    expect(encoded["contract_version"]).toBe("ghostping-worker-result-v1")
    expect(encoded["run_id"]).toBe("RUN-FIXTURE-1")
  })

  it("unknown contract version is rejected", () => {
    const tampered = { ...(fixture("job-v1.valid.json") as Record<string, unknown>), contract_version: "ghostping-worker-job-v99" }
    expect(decodeEither(WorkerJobV1, tampered)._tag).toBe("Left")
  })

  it("wrong field type is rejected", () => {
    const tampered = { ...(fixture("job-v1.valid.json") as Record<string, unknown>), run_id: 42 }
    expect(decodeEither(WorkerJobV1, tampered)._tag).toBe("Left")
  })

  it("missing required field is rejected", () => {
    const tampered = { ...(fixture("result-v1.success.json") as Record<string, unknown>) }
    delete tampered["raw_digest"]
    expect(decodeEither(WorkerResultV1, tampered)._tag).toBe("Left")
  })
})

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
