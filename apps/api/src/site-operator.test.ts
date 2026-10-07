// SEARCH_OPERATOR_V1 API boundary: URL validation and guarded finding
// transitions. DB-free: stubbed Effect layers.
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SiteFindingRepository } from "@openrecord/db"
import { canRecordMutationState, transitionFinding, validateSiteRoot } from "./site-operator.js"

describe("validateSiteRoot", () => {
  it("accepts an https URL with origin and path prefix", () => {
    const checked = validateSiteRoot("https://example.com")
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      expect(checked.canonicalOrigin).toBe("https://example.com")
      expect(checked.rootUrl).toBe("https://example.com")
    }
  })

  it("rejects non-http schemes, credentials, and blanks", () => {
    expect(validateSiteRoot("ftp://example.com").ok).toBe(false)
    expect(validateSiteRoot("https://user:pass@example.com").ok).toBe(false)
    expect(validateSiteRoot("").ok).toBe(false)
    expect(validateSiteRoot("not a url").ok).toBe(false)
    // Private targets are rejected at fetch time (fail closed), but
    // registration of an https URL is syntactically accepted here.
    expect(validateSiteRoot("http://127.0.0.1/").ok).toBe(true)
  })
})

const findingStub = (status: string) => {
  const events: Array<{ from: string | null; to: string }> = []
  const service = {
    upsertByIdentity: () => Effect.dieMessage("unused"),
    listByBusiness: () => Effect.succeed([]),
    listByTarget: () => Effect.succeed([]),
    getScoped: (_businessId: string, _findingId: string) =>
      Effect.succeed({
        id: "f1",
        businessId: "b1",
        siteTargetId: "s1",
        runId: "r1",
        pageObservationId: null,
        url: "https://example.com/x",
        canonicalUrl: "https://example.com/x",
        findingKind: "BLOCKED_BY_META",
        severity: "HIGH",
        category: "CRAWL_INDEX_RISK",
        status,
        detectedAt: new Date().toISOString(),
        evidence: {},
        diagnosis: "d",
        recommendedAction: "r",
        confidence: "HIGH",
        sourceDigest: null,
        evidenceDigest: null,
        identityKey: "k",
      }),
    setStatus: (_businessId: string, _findingId: string, toStatus: string) =>
      Effect.sync(() => {
        events.push({ from: status, to: toStatus })
        return { id: "f1", status: toStatus } as never
      }),
  }
  return { events, layer: Layer.succeed(SiteFindingRepository, service as never) }
}

describe("transitionFinding", () => {
  it("allows OPEN -> AWAITING_APPROVAL and records history", async () => {
    const stub = findingStub("OPEN")
    const result = await Effect.runPromise(
      transitionFinding("b1", "f1", "AWAITING_APPROVAL", "tester").pipe(Effect.provide(stub.layer)),
    )
    expect((result as { status: string }).status).toBe("AWAITING_APPROVAL")
    expect(stub.events).toEqual([{ from: "OPEN", to: "AWAITING_APPROVAL" }])
  })

  it("refuses silent success jumps (OPEN -> VERIFIED_FIXED)", async () => {
    const stub = findingStub("OPEN")
    const result = await Effect.runPromise(
      transitionFinding("b1", "f1", "VERIFIED_FIXED", "tester").pipe(Effect.provide(stub.layer)),
    )
    expect(result).toMatchObject({ error: expect.stringContaining("InvalidFindingTransition") })
    expect(stub.events).toEqual([])
  })
})

describe("canRecordMutationState", () => {
  it("allows the observed merge path and nothing else", () => {
    expect(canRecordMutationState("CREATED", "BRANCH_CREATED")).toBe(true)
    expect(canRecordMutationState("BRANCH_CREATED", "PR_OPEN")).toBe(true)
    expect(canRecordMutationState("PR_OPEN", "MERGED")).toBe(true)
    // OpenRecord never merges by itself: MERGED is reachable only from PR_OPEN.
    expect(canRecordMutationState("CREATED", "MERGED")).toBe(false)
    expect(canRecordMutationState("CREATED", "PR_OPEN")).toBe(false)
    expect(canRecordMutationState("MERGED", "PR_OPEN")).toBe(false)
    expect(canRecordMutationState("PR_OPEN", "FAILED")).toBe(true)
  })
})
