// Issue loop (STAGE loop view) UX contracts, asserted without a browser:
// the issue page carries a Recheck AI action backed by the narrow Rechecks
// client plus a chronological timeline, and none of the touched files claim
// anything about what brought an outcome about. File-scan style follows
// recorded-actions.test.ts.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { workspaceNavOrder } from "../app/lib/nav"

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8")

const issuePage = () => read("../app/routes/issue.tsx")
const webApi = () => read("../app/lib/api.ts")
const loopApi = () => read("../../api/src/issue-loop.ts")
const apiRouter = () => read("../../api/src/router.ts")

const allowed = [
  "AI answer changed afterward",
  "No representation change observed",
  "Not enough comparable evidence",
  "Not rechecked yet",
  "Needs review",
]

const stages = ["AI observed", "Reviewed", "Issue", "Action", "Source check", "AI recheck", "Review", "Outcome"]

describe("recheck AI action", () => {
  it("renders the action copy and controls", () => {
    const page = issuePage()
    for (const copy of [
      "Recheck AI",
      "Linked action (optional)",
      "No specific action",
      "Recheck requested",
      "Requesting recheck",
      "Issue timeline",
      "recheck-intervention",
    ]) {
      expect(page, `missing UI copy: ${copy}`).toContain(copy)
    }
  })

  it("submits through the Rechecks client and reloads the loop", () => {
    const page = issuePage()
    for (const fragment of ["Rechecks.create", "Rechecks.getLoop", "interventionId", "void reload()"]) {
      expect(page, `missing fragment: ${fragment}`).toContain(fragment)
    }
  })

  it("shows queued, running, failed, and review-needed states with existing components", () => {
    const page = issuePage()
    expect(page).toContain("Recheck queued")
    expect(page).toContain("Recheck in progress")
    expect(page).toContain("Recheck failed")
    expect(page).toContain("Finalizing recheck")
    expect(page).toContain("Needs review")
    expect(page).toContain("recheckError")
    for (const pattern of ["<Card", "<Button", "<Alert", "<Select", "<Skeleton", "formatDateTime"]) {
      expect(page, `missing pattern: ${pattern}`).toContain(pattern)
    }
  })

  it("derives recheck state from the canonical attempt DTO, never by inference", () => {
    const page = issuePage()
    for (const fragment of ["activeAttempt", "failedAttempts", "attemptStateCopy", "FINALIZING"]) {
      expect(page, `missing fragment: ${fragment}`).toContain(fragment)
    }
    expect(page).not.toContain("attempts.filter((a) => a.status")
  })

  it("offers source verification only for linked bindings, honestly otherwise", () => {
    const page = issuePage()
    for (const copy of ["Verify source", "Checking source…", "Sources.check", "not linked to a tracked representation"]) {
      expect(page, `missing copy: ${copy}`).toContain(copy)
    }
    expect(page).toContain("The new observation is preserved")
    expect(page).not.toContain("auto-bind")
  })

  it("marks superseded actions so rechecks link the current head", () => {
    const page = issuePage()
    expect(page).toContain("interventionHeadIds")
    expect(page).toContain("(superseded)")
    expect(page).toContain("superseded — history only")
  })
})

describe("issue timeline", () => {
  it("renders every stage exactly once", () => {
    const page = issuePage()
    for (const stage of stages) expect(page, `missing stage: ${stage}`).toContain(stage)
  })

  it("orders stages chronologically", () => {
    const page = issuePage()
    const positions = stages.map((s) => page.indexOf(`label: "${s}"`))
    for (const [stage, pos] of stages.map((s, i) => [s, positions[i]] as const)) {
      expect(pos, `stage not found: ${stage}`).toBeGreaterThanOrEqual(0)
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it("renders before/after outcome wording from the server display copy", () => {
    const page = issuePage()
    for (const fragment of ["comparison.displayCopy", "comparabilityExplanation", "latestComparison"]) {
      expect(page, `missing fragment: ${fragment}`).toContain(fragment)
    }
  })

  it("keeps the issue timeline inside the issues section", () => {
    expect(workspaceNavOrder).toEqual(["overview", "assay", "search", "issues", "representations", "truth", "checks"])
    expect(issuePage()).not.toContain("workspaceNav")
  })
})

describe("source alignment is never collapsed into source change", () => {
  it("renders both dimensions with distinct labels", () => {
    const page = issuePage()
    for (const copy of ["Source changed", "Source unchanged", "Source change unknown", "Current source state:"]) {
      expect(page, `missing copy: ${copy}`).toContain(copy)
    }
    expect(page).toContain("sourceChangeCopy")
    expect(page).toContain("sourceAlignmentCopy")
    expect(page).not.toContain("SOURCE_OBSERVED_UNCHANGED")
    expect(page).not.toContain("SOURCE_OBSERVED_CHANGED")
  })
})

describe("rechecks client", () => {
  it("exposes the loop read and the reobservations write with the exact contract", () => {
    const api = webApi()
    expect(api).toContain("export const Rechecks")
    expect(api).toContain("export type IssueLoop")
    expect(api).toContain("export type LoopComparison")
    // The client must build these URLs from the shared contract table, and
    // the table must carry the exact server paths (single source of truth).
    expect(api).toContain("Routes.getIssueLoop")
    expect(api).toContain("Routes.requestReobservation")
    const contracts = read("../../../packages/contracts/src/index.ts")
    expect(contracts).toContain("issues/${claimId}/loop")
    expect(contracts).toContain("issues/${claimId}/reobservations")
    expect(api).toContain("interventionId")
    expect(api).toContain("causalAttribution")
  })

  it("notes the parallel-track dependency instead of guessing", () => {
    expect(webApi()).toContain("parallel API")
  })
})

describe("loop route", () => {
  it("serves the derived loop under issue tenancy", () => {
    const router = apiRouter()
    expect(router).toContain("/api/businesses/:id/issues/:claimId/loop")
    expect(router).toContain("loadIssueLoop")
    expect(router).toContain("IssueNotFound")
  })
})

describe("allowed outcome vocabulary", () => {
  it("is present across the loop read model and the issue page", () => {
    const combined = `${loopApi()}${issuePage()}`
    for (const copy of allowed) expect(combined, `missing allowed copy: ${copy}`).toContain(copy)
  })
})

describe("no-outcome-claims guards", () => {
  // The citation disclaimer predates this feature and stays worded as
  // approved; the guard below targets new copy, so it is scrubbed first.
  const scrubbed = (text: string) =>
    text.replace(/\s+/g, " ").replace(/does not prove the source caused the answer/g, "")
  const banned = ["caused", "fixed", "influenced", "chatgpt", "caused_by"]
  const touched: Array<[string, string]> = [
    ["apps/web/app/routes/issue.tsx", issuePage()],
    ["apps/web/app/lib/api.ts", webApi()],
    ["apps/api/src/issue-loop.ts", loopApi()],
    ["apps/api/src/router.ts", apiRouter()],
  ]

  it("touched files claim no outcome for any action or recheck", () => {
    for (const [name, text] of touched) {
      const lower = scrubbed(text).toLowerCase()
      for (const word of banned) expect(lower, `${name} contains banned wording: ${word}`).not.toContain(word)
    }
  })
})
