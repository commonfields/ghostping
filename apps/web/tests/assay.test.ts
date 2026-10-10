import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { ASSAY_RETRIEVAL_LIMITATION, AssayRoutes } from "@openrecord/contracts"
import { workspaceNav } from "../app/lib/nav"
describe("assay operator surface", () => {
  it("is reachable and preserves the retrieval limitation wording", () => {
    expect(workspaceNav("/businesses/b").find(n => n.id === "assay")?.path).toBe("/businesses/b/assay")
    expect(AssayRoutes.reviewFact("b", "f")).toBe("/api/businesses/b/assay/facts/f/review")
    expect(ASSAY_RETRIEVAL_LIMITATION).toBe("This answer was produced without live web retrieval. Changes to public webpages are not expected to reliably alter this result within the pilot timeframe.")
  })
  it("shows source and sample evidence and requires a reason before reviews", () => {
    const page = readFileSync(new URL("../app/routes/assay.tsx", import.meta.url), "utf8")
    for (const text of ["Facts awaiting confirmation", "Findings awaiting review", "source_diagnosis", "supportingSpan", "failureClass", "ASSAY_RETRIEVAL_LIMITATION", "!reason.trim()", "Full answer and provenance"]) expect(page).toContain(text)
    expect(page).not.toContain("dangerouslySetInnerHTML")
  })
  it("shows the limitation for every non-retrieval class, the snapshot rule, redirects, and hides mock unless enabled", () => {
    const page = readFileSync(new URL("../app/routes/assay.tsx", import.meta.url), "utf8")
    expect(page).toContain('finding.retrieval_class !== "RETRIEVAL_ENABLED" ? <p className="text-xs text-muted-foreground">{ASSAY_RETRIEVAL_LIMITATION}</p>')
    for (const text of ["Answers collected before the page snapshot are not compared.", "Page snapshot:", "fact.final_url ?? fact.source_url", "(cross-origin redirect)", "providers.data?.assaySyntheticEnabled", "Mock observations are synthetic fixtures."]) expect(page).toContain(text)
  })
})
