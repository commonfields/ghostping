// Recorded actions (ACT stage) product surface, asserted without a
// browser: the issue detail page carries a "Recorded actions" card backed
// by the Interventions client, and none of the touched files claim
// causality. Follows the file-scan style of product-surface.test.ts.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8")

const issuePage = () => read("../app/routes/issue.tsx")
const webApi = () => read("../app/lib/api.ts")
const apiRouter = () => read("../../api/src/router.ts")
const apiHelpers = () => read("../../api/src/interventions.ts")
const apiServer = () => read("../../api/src/server.ts")
const apiTests = () => read("../../api/src/interventions.test.ts")
const contracts = () => read("../../../packages/contracts/src/index.ts")

const interventionTypes = [
  "SOURCE_UPDATED",
  "SOURCE_PUBLISHED",
  "THIRD_PARTY_CORRECTION_REQUESTED",
  "KNOWLEDGE_BASE_UPDATED",
  "STRUCTURED_DATA_UPDATED",
  "OTHER",
]

describe("recorded actions card", () => {
  it("renders the card copy and form controls", () => {
    const page = issuePage()
    for (const copy of [
      "Recorded actions",
      "Record action",
      "Action type",
      "Target",
      "Notes",
      "No actions recorded for this issue yet.",
      "Action recorded",
      "action-type",
      "action-target",
      "action-notes",
    ]) {
      expect(page, `missing UI copy: ${copy}`).toContain(copy)
    }
  })

  it("offers every recorded-action type", () => {
    const page = issuePage()
    for (const type of interventionTypes) expect(page, `missing type: ${type}`).toContain(type)
  })

  it("submits through the Interventions client and lists type, target, performed date, notes", () => {
    const page = issuePage()
    for (const fragment of [
      "Interventions.list",
      "Interventions.create",
      "sentenceCase(a.type)",
      "a.target",
      "a.performedAt",
      "a.notes",
    ]) {
      expect(page, `missing fragment: ${fragment}`).toContain(fragment)
    }
  })

  it("reuses the existing card, badge, alert, and button patterns", () => {
    const page = issuePage()
    for (const fragment of ["<Card", "<Badge", "<Alert", "<Button", "formatDateTime"]) {
      expect(page, `missing pattern: ${fragment}`).toContain(fragment)
    }
  })
})

describe("interventions client", () => {
  it("exposes list and create against the issue interventions routes", () => {
    const api = webApi()
    expect(api).toContain("export const Interventions")
    expect(api).toContain("export type Intervention")
    expect(api).toContain("issues/${claimId}/interventions")
    for (const field of ["type: string", "target: string", "performedAt: string", "notes: string | null"]) {
      expect(api, `missing field: ${field}`).toContain(field)
    }
  })
})

describe("no-causality guards", () => {
  // The citation disclaimer predates this feature and stays worded as
  // approved; the guard below targets new copy, so it is scrubbed first.
  const scrubbed = (text: string) =>
    text.replace(/\s+/g, " ").replace(/does not prove the source caused the answer/g, "")
  const banned = ["caused", "fixed", "influenced", "chatgpt"]
  const touched: Array<[string, string]> = [
    ["apps/web/app/routes/issue.tsx", issuePage()],
    ["apps/web/app/lib/api.ts", webApi()],
    ["apps/api/src/router.ts", apiRouter()],
    ["apps/api/src/interventions.ts", apiHelpers()],
    ["apps/api/src/server.ts", apiServer()],
    ["apps/api/src/interventions.test.ts", apiTests()],
    ["packages/contracts/src/index.ts", contracts()],
  ]

  it("touched files claim no outcome for a recorded action", () => {
    for (const [name, text] of touched) {
      const lower = scrubbed(text).toLowerCase()
      for (const word of banned) expect(lower, `${name} contains banned word: ${word}`).not.toContain(word)
    }
  })

  it("touched API files keep the recorded-action vocabulary", () => {
    for (const text of [apiRouter(), apiHelpers()]) {
      expect(text.toLowerCase()).toContain("recorded action")
    }
  })
})
