import { describe, expect, it } from "vitest"
import {
  assertCheckTransition,
  dateOnlyToEndExclusiveUtc,
  dateOnlyToStartUtc,
  deriveIssueState,
  detectAuthorityConflicts,
  intervalsOverlap,
  isRetryableFailure,
  latestJudgment,
  validateFactValue,
  validateValidityWindow,
  type HumanJudgment,
} from "../src/index.js"

describe("temporal boundaries", () => {
  it("date-only maps to [start, next-day) UTC", () => {
    const s = dateOnlyToStartUtc("2026-01-01")
    const e = dateOnlyToEndExclusiveUtc("2026-01-01")
    expect(s.toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(e.toISOString()).toBe("2026-01-02T00:00:00.000Z")
    expect(intervalsOverlap({ start: s, end: e }, { start: e, end: null })).toBe(false)
  })
  it("rfc3339 normalizes to instant", () => {
    expect(new Date("2026-09-30T00:00:00+02:00").toISOString()).toBe("2026-09-29T22:00:00.000Z")
  })
  it("rejects empty validity window", () => {
    expect(() => validateValidityWindow("2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z")).toThrow()
  })
})

describe("facts", () => {
  it("validates values", () => {
    expect(() => validateFactValue("CURRENCY", "$39")).not.toThrow()
    expect(() => validateFactValue("CURRENCY", "")).toThrow()
    expect(() => validateFactValue("URL", "not-a-url")).toThrow()
    expect(() => validateFactValue("BOOLEAN", "false")).not.toThrow()
  })
  it("detects FACT_AUTHORITY_CONFLICT on overlap", () => {
    const conflicts = detectAuthorityConflicts(([
      { id: "f1", businessId: "b", subject: "northstar", predicate: "monthly_price", status: "ACTIVE", validFrom: "2026-01-01T00:00:00Z", validUntil: null },
      { id: "f2", businessId: "b", subject: "northstar", predicate: "monthly_price", status: "ACTIVE", validFrom: "2026-09-01T00:00:00Z", validUntil: null },
    ]) as never)
    expect(conflicts).toHaveLength(1)
  })
  it("ignores non-overlapping and retired facts", () => {
    const conflicts = detectAuthorityConflicts(([
      { id: "f1", businessId: "b", subject: "s", predicate: "p", status: "ACTIVE", validFrom: "2026-01-01T00:00:00Z", validUntil: "2026-02-01T00:00:00Z" },
      { id: "f2", businessId: "b", subject: "s", predicate: "p", status: "ACTIVE", validFrom: "2026-02-01T00:00:00Z", validUntil: null },
      { id: "f3", businessId: "b", subject: "s", predicate: "p", status: "RETIRED", validFrom: "2026-01-15T00:00:00Z", validUntil: null },
    ]) as never)
    expect(conflicts).toHaveLength(0)
  })
})

describe("checks", () => {
  it("enforces QUEUED->RUNNING->SUCCEEDED|FAILED", () => {
    expect(() => assertCheckTransition("QUEUED", "RUNNING")).not.toThrow()
    expect(() => assertCheckTransition("RUNNING", "SUCCEEDED")).not.toThrow()
    expect(() => assertCheckTransition("SUCCEEDED", "FAILED")).toThrow()
    expect(() => assertCheckTransition("QUEUED", "SUCCEEDED")).toThrow()
  })
  it("classifies retryable failures", () => {
    expect(isRetryableFailure("PROVIDER_RATE_LIMITED")).toBe(true)
    expect(isRetryableFailure("PROVIDER_AUTH")).toBe(false)
    expect(isRetryableFailure("PROVIDER_MALFORMED")).toBe(false)
  })
})

describe("judgments + issues", () => {
  const j = (v: HumanJudgment["verdict"], id: string): HumanJudgment => ({
    id: id as never, businessId: "b" as never, claimId: "c" as never, verdict: v,
    notes: null, factIds: [], supersedesId: null, createdAt: "2026-09-30T00:00:00Z" as never,
  })
  it("resolves the chain-derived head (no mutable flags)", () => {
    const j1 = { ...j("SUPPORTED", "j1"), createdAt: "2026-01-01T00:00:00Z" as never }
    const j2 = { ...j("CONTRADICTED", "j2"), supersedesId: "j1" as never }
    // j1 is historical because j2 points at it — j1 itself is unchanged.
    expect(latestJudgment([j1, j2])?.id).toBe("j2")
    expect(j1.supersedesId).toBeNull()
    expect(j2.supersedesId).toBe("j1")
  })
  it("follows a three-link supersession chain", () => {
    const j1 = { ...j("SUPPORTED", "j1"), createdAt: "2026-01-01T00:00:00Z" as never }
    const j2 = { ...j("CONTRADICTED", "j2"), supersedesId: "j1" as never, createdAt: "2026-01-02T00:00:00Z" as never }
    const j3 = { ...j("SUPPORTED", "j3"), supersedesId: "j2" as never, createdAt: "2026-01-03T00:00:00Z" as never }
    expect(latestJudgment([j1, j2, j3])?.id).toBe("j3")
  })
  it("derives inbox states", () => {
    expect(deriveIssueState(null)).toBe("NEEDS_REVIEW")
    expect(deriveIssueState(j("CONTRADICTED", "x"))).toBe("WRONG")
    expect(deriveIssueState(j("PARTIAL", "x"))).toBe("PARTIAL")
    expect(deriveIssueState(j("INSUFFICIENT_EVIDENCE", "x"))).toBe("UNKNOWN")
    expect(deriveIssueState(j("SUPPORTED", "x"))).toBe("RESOLVED")
  })
})
