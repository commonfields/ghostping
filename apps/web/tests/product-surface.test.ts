import { describe, expect, it } from "vitest"

// Product Surface V1 UX contracts, asserted without a browser: navigation
// order/labels/routes come from lib/nav, status language from status meta,
// and banned phrases are file-scanned like the existing no-score guard.

import { representationFilterLabels, representationFilters, sectionTitles, workspaceNav, workspaceNavOrder } from "../app/lib/nav"
import { issueStateMeta, representationStateMeta } from "../app/components/status"

describe("navigation", () => {
  it("sidebar follows the operational workflow order", () => {
    expect(workspaceNavOrder).toEqual(["overview", "search", "issues", "representations", "truth", "checks"])
    const items = workspaceNav("/businesses/b1")
    expect(items.map((i) => i.id)).toEqual(workspaceNavOrder)
    expect(items.map((i) => i.label)).toEqual(["Overview", "Search", "Issues", "Representations", "Truth", "Checks"])
    expect(items.map((i) => i.path)).toEqual([
      "/businesses/b1/overview",
      "/businesses/b1/search",
      "/businesses/b1/issues",
      "/businesses/b1/representations",
      "/businesses/b1/truth",
      "/businesses/b1/checks",
    ])
  })

  it("search section reports concrete state, never scores", async () => {
    const fs = await import("node:fs")
    const page = fs.readFileSync(new URL("../app/routes/search.tsx", import.meta.url), "utf8")
    expect(page).toContain("Needs attention")
    expect(page).toContain("Verification pending")
    expect(page).toContain("Verified fixed")
    expect(page).not.toMatch(/score/i)
    const finding = fs.readFileSync(new URL("../app/routes/site-finding.tsx", import.meta.url), "utf8")
    expect(finding).toContain("Observed evidence")
    expect(finding).toContain("Proposed fix")
    expect(finding).toContain("Ghostping verified the fix on the live site")
    expect(finding).not.toMatch(/score/i)
  })

  it("breadcrumbs cover every product section in existing style", () => {
    expect(sectionTitles).toMatchObject({
      overview: "Overview",
      issues: "Issues",
      representations: "Representations",
      truth: "Truth",
      checks: "Checks",
      facts: "Truth",
    })
  })

  it("representation filters follow the issues tab pattern", () => {
    expect(representationFilters).toEqual(["ALL", "DRIFT", "UNKNOWN", "IN_SYNC"])
    expect(representationFilterLabels).toEqual({ ALL: "All", DRIFT: "Drift", UNKNOWN: "Unknown", IN_SYNC: "In sync" })
  })
})

describe("truth", () => {
  it("repository authority renders a banner, never an edit control", async () => {
    const fs = await import("node:fs")
    const text = fs.readFileSync(new URL("../app/routes/truth.tsx", import.meta.url), "utf8")
    expect(text).toContain("Managed by repository manifest")
    expect(text).toContain("Managed in Ghostping")
    expect(text).toContain("View history")
    expect(text).toContain("Unknown")
  })

  it("history dialog renders per-version provenance or honest absence", async () => {
    const fs = await import("node:fs")
    const text = fs.readFileSync(new URL("../app/routes/truth.tsx", import.meta.url), "utf8")
    expect(text).toContain("<ManifestProvenance provenance={h.provenance} />")
    expect(text).toContain("Entered by hand — no repository provenance.")
    const component = fs.readFileSync(new URL("../app/routes/truth.tsx", import.meta.url), "utf8")
    for (const field of ["Manifest key", "Source URL", "Source revision", "Last synchronized", "Manifest digest"]) {
      expect(component).toContain(field)
    }
  })

  it("legacy facts route redirects compatibly", async () => {
    const fs = await import("node:fs")
    const facts = fs.readFileSync(new URL("../app/routes/facts.tsx", import.meta.url), "utf8")
    expect(facts).toContain('to="../truth"')
    const main = fs.readFileSync(new URL("../app/main.tsx", import.meta.url), "utf8")
    expect(main).toContain('path="truth"')
    expect(main).toContain('path="representations"')
    expect(main).toContain('path="representations/:bindingId"')
    expect(main).toContain('path="issues/:claimId"')
  })
})

describe("representations", () => {
  it("finding labels reuse the supported/wrong/unknown color language", () => {
    expect(representationStateMeta.IN_SYNC).toMatchObject({ label: "In sync", variant: "supported" })
    expect(representationStateMeta.DRIFT).toMatchObject({ label: "Drift", variant: "wrong" })
    expect(representationStateMeta.UNKNOWN).toMatchObject({ label: "Unknown", variant: "unknown" })
  })

  it("surfaces distinguish absence, failure, and drift", async () => {
    const fs = await import("node:fs")
    const list = fs.readFileSync(new URL("../app/routes/representations.tsx", import.meta.url), "utf8")
    expect(list).toContain("No tracked representations yet")
    expect(list).toContain("Not observed yet")
    expect(list).toContain("Latest check failed")
    expect(list).toContain("does not mean everything is in sync")
    const detail = fs.readFileSync(new URL("../app/routes/representation.tsx", import.meta.url), "utf8")
    expect(detail.replace(/\s+/g, " ")).toContain("does not prove the source caused the answer")
    expect(detail).not.toMatch(/CAUSED_BY/)
  })

  it("never labels the effective-value timestamp as the last successful check", async () => {
    const fs = await import("node:fs")
    const detail = fs.readFileSync(new URL("../app/routes/representation.tsx", import.meta.url), "utf8")
    expect(detail).toContain("Last checked")
    expect(detail).toContain("Last successful check")
    expect(detail).toContain("Value evidence observed")
    expect(detail).not.toContain("Last successful observation")
  })
})

describe("issues", () => {
  it("issue detail renders claim, truth, citation, verdict without causality", async () => {
    const fs = await import("node:fs")
    const detail = fs.readFileSync(new URL("../app/routes/issue.tsx", import.meta.url), "utf8")
    for (const section of ["AI said", "Approved truth", "Source evidence", "Reviewer decision"]) {
      expect(detail).toContain(section)
    }
    expect(detail).toContain("Not tracked")
    expect(detail).toContain("No source citation was returned with this observation.")
    expect(detail.replace(/\s+/g, " ")).toContain("does not prove the source caused the answer")
    expect(detail).not.toContain("CAUSED_BY")
  })

  it("reviewed issues link to issue detail, unreviewed to the answer", async () => {
    const fs = await import("node:fs")
    const list = fs.readFileSync(new URL("../app/routes/issues.tsx", import.meta.url), "utf8")
    expect(list).toContain("View issue")
    expect(list).toContain("Review claim")
    expect(list).toContain("No source citation returned.")
  })

  it("linked facts render their immutable version", async () => {
    const fs = await import("node:fs")
    const detail = fs.readFileSync(new URL("../app/routes/issue.tsx", import.meta.url), "utf8")
    expect(detail).toContain("v{f.version}")
    const list = fs.readFileSync(new URL("../app/routes/issues.tsx", import.meta.url), "utf8")
    expect(list).toContain("v{f.version}")
    const api = fs.readFileSync(new URL("../app/lib/api.ts", import.meta.url), "utf8")
    expect(api).toContain("version: number")
  })
})

describe("observation", () => {
  it("citations render only when present with tracked links", async () => {
    const fs = await import("node:fs")
    const page = fs.readFileSync(new URL("../app/routes/observation.tsx", import.meta.url), "utf8")
    expect(page).toContain("No source citation was returned with this observation.")
    expect(page).toContain("View tracked representation")
  })
})

describe("issue states keep existing reviewer language", () => {
  it("wrong/partial/unknown/review labels unchanged", () => {
    expect(issueStateMeta.WRONG.label).toBe("Wrong")
    expect(issueStateMeta.PARTIAL.label).toBe("Partially correct")
    expect(issueStateMeta.UNKNOWN.label).toBe("Not enough information")
    expect(issueStateMeta.NEEDS_REVIEW.label).toBe("Needs review")
  })
})

describe("language guards", () => {
  it("rejects score, causality, and unproven-state phrases", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app")
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    const banned = [
      "accuracy score",
      "visibility score",
      "health score",
      "source influence",
      "ai optimization score",
      "caused the ai to",
      "caused_by",
      "delivered ✓",
      "indexed ✓",
    ]
    for (const f of walk(root)) {
      const text = fs.readFileSync(f, "utf8").toLowerCase()
      for (const b of banned) expect(text, `${f} contains banned phrase: ${b}`).not.toContain(b)
    }
  })

  it("never claims publication without a data contract", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app")
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    for (const f of walk(root)) {
      const text = fs.readFileSync(f, "utf8")
      if (/published/i.test(text)) {
        expect(text, `${f} must not claim publication`).toMatch(/never|not.*publish|SOURCE_PUBLISHED/i)
      }
    }
  })
})
