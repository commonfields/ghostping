import { describe, expect, it } from "vitest"
import { buildAuthoritySnapshot, shouldRefetchBody, snapshotsEqual } from "../src/service.js"

const row = (
  id: string,
  root: string,
  version: number,
  valueText: string,
  supersedesId: string | null,
  valueType: "TEXT" | "CURRENCY" | "BOOLEAN" = "TEXT",
) => ({ id, lineageRootId: root, version, valueText, supersedesId, valueType })

describe("buildAuthoritySnapshot", () => {
  it("freezes head as current with distinct historical values", () => {
    const snap = buildAuthoritySnapshot([
      row("f1", "r1", 1, "49.00 USD", null, "CURRENCY"),
      row("f2", "r1", 2, "59.00 USD", "f1", "CURRENCY"),
    ])
    expect(snap.unsupported).toEqual([])
    expect(snap.lineages).toHaveLength(1)
    expect(snap.lineages[0]).toMatchObject({
      rootId: "r1",
      activeId: "f2",
      activeVersion: 2,
      currentValue: "59.00 USD",
    })
    expect(snap.lineages[0]!.historicalValues).toEqual([{ factId: "f1", version: 1, value: "49.00 USD" }])
    expect(snap.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is deterministic and digest-stable", () => {
    const facts = [
      row("f2", "r1", 2, "b", "f1"),
      row("f1", "r1", 1, "a", null),
      row("g1", "r2", 1, "x", null),
    ]
    const a = buildAuthoritySnapshot(facts)
    const b = buildAuthoritySnapshot([...facts].reverse())
    expect(a.digest).toBe(b.digest)
    expect(snapshotsEqual(a, b)).toBe(true)
  })

  it("treats metadata-only same-value versions as current, not historical", () => {
    const snap = buildAuthoritySnapshot([
      row("f1", "r1", 1, "Acme", null),
      row("f2", "r1", 2, "Acme", "f1"),
      row("f3", "r1", 3, "Acme Pro", "f2"),
    ])
    expect(snap.lineages[0]!.currentValue).toBe("Acme Pro")
    expect(snap.lineages[0]!.historicalValues).toEqual([{ factId: "f1", version: 1, value: "Acme" }])
  })

  it("marks forks UNSUPPORTED", () => {
    const snap = buildAuthoritySnapshot([
      row("f1", "r1", 1, "a", null),
      row("f2", "r1", 2, "b", "f1"),
      row("f3", "r1", 2, "c", "f1"),
    ])
    expect(snap.lineages).toHaveLength(0)
    expect(snap.unsupported).toEqual([{ rootId: "r1", reason: "FORK" }])
  })

  it("marks cycles UNSUPPORTED", () => {
    const snap = buildAuthoritySnapshot([
      row("f1", "r1", 1, "a", "f2"),
      row("f2", "r1", 2, "b", "f1"),
    ])
    expect(snap.lineages).toHaveLength(0)
    expect(snap.unsupported[0]!.reason).toBe("CYCLE")
  })

  it("rejects self-supersession and dangling parents", () => {
    const self = buildAuthoritySnapshot([row("f1", "r1", 1, "a", "f1")])
    expect(self.unsupported).toEqual([{ rootId: "r1", reason: "SELF_SUPERSESSION" }])
    const dangling = buildAuthoritySnapshot([row("f1", "r1", 1, "a", "missing")])
    expect(dangling.unsupported).toEqual([{ rootId: "r1", reason: "DANGLING_PARENT" }])
  })
})

describe("shouldRefetchBody", () => {
  it("allows 304 reuse only when authority and matcher are unchanged with a body", () => {
    expect(shouldRefetchBody({ authoritySame: true, matcherSame: true, hasBody: true })).toBe(false)
  })
  it("forces body on authority change, matcher change, or missing body", () => {
    expect(shouldRefetchBody({ authoritySame: false, matcherSame: true, hasBody: true })).toBe(true)
    expect(shouldRefetchBody({ authoritySame: true, matcherSame: false, hasBody: true })).toBe(true)
    expect(shouldRefetchBody({ authoritySame: true, matcherSame: true, hasBody: false })).toBe(true)
  })
})
