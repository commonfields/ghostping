// Candidate-group counting: candidates_found must count logical candidates
// (page + lineage), never raw match events. Pure unit tests, no Postgres.
import { describe, expect, it } from "vitest"
import { countCandidateGroups } from "@ghostping/discovery"

describe("countCandidateGroups", () => {
  it("17 identical occurrences on one page/lineage count as one candidate", () => {
    const events = Array.from({ length: 17 }, () => ({ pageKey: "https://acme.com/pricing", lineageRootFactId: "root-1" }))
    expect(countCandidateGroups(events)).toBe(1)
  })

  it("current + historical occurrences on the same page/lineage count once", () => {
    expect(
      countCandidateGroups([
        { pageKey: "https://acme.com/compare", lineageRootFactId: "root-1" },
        { pageKey: "https://acme.com/compare", lineageRootFactId: "root-1" },
      ]),
    ).toBe(1)
  })

  it("one page with two lineages counts two", () => {
    expect(
      countCandidateGroups([
        { pageKey: "https://acme.com/compare", lineageRootFactId: "root-1" },
        { pageKey: "https://acme.com/compare", lineageRootFactId: "root-2" },
      ]),
    ).toBe(2)
  })

  it("two pages with the same lineage count two", () => {
    expect(
      countCandidateGroups([
        { pageKey: "https://acme.com/pricing", lineageRootFactId: "root-1" },
        { pageKey: "https://acme.com/docs", lineageRootFactId: "root-1" },
      ]),
    ).toBe(2)
  })

  it("empty match list counts zero (304 with no prior evidence invents nothing)", () => {
    expect(countCandidateGroups([])).toBe(0)
  })
})
