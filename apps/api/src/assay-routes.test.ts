import { describe, expect, it } from "vitest"
import { ReviewAssayFactRequest, ReviewAssayFindingRequest, RunAssayRequest } from "@openrecord/contracts"
import { decodeAssayRequest } from "./assay-routes.js"
describe("assay request boundary", () => {
  it("rejects body-supplied reviewer and timestamps for both review endpoints", () => {
    for (const [schema, decision] of [[ReviewAssayFactRequest, "CONFIRMED"], [ReviewAssayFindingRequest, "REVIEWED_CORRECT"]] as const) {
      // Separate schemas share the same untrusted-body rule.
      for (const field of ["reviewed_by", "reviewedBy", "reviewed_at", "userId"]) {
        const body = { decision, reason: "TEST reviewer reason", [field]: "forged" }
        expect(schema === ReviewAssayFactRequest ? decodeAssayRequest(ReviewAssayFactRequest, body) : decodeAssayRequest(ReviewAssayFindingRequest, body)).toBeNull()
      }
    }
  })
  it("requires a real decision and a nonblank reason", () => {
    expect(decodeAssayRequest(ReviewAssayFactRequest, { decision: "CONFIRMED", reason: " " })).toBeNull()
    expect(decodeAssayRequest(ReviewAssayFactRequest, { decision: "AUTO_CONFIRMED", reason: "why" })).toBeNull()
    expect(decodeAssayRequest(ReviewAssayFindingRequest, { decision: "REVIEWED_CORRECT", reason: "why" })).toEqual({ decision: "REVIEWED_CORRECT", reason: "why" })
  })
  it("bounds sampling and validates retrieval vocabulary", () => {
    const input = { questionId: "00000000-0000-4000-8000-000000000001", provider: "mock", requestedModel: null, retrievalMode: "NONE" }
    for (const n of [0, 21, 1.5]) expect(decodeAssayRequest(RunAssayRequest, { ...input, n })).toBeNull()
    expect(decodeAssayRequest(RunAssayRequest, input)).not.toBeNull()
    expect(decodeAssayRequest(RunAssayRequest, { ...input, retrievalMode: "pretend" })).toBeNull()
  })
})
