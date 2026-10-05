import { describe, expect, it } from "vitest"

// Representation Discovery V1 UX contracts, asserted without a browser:
// route + client surface come from file scans (same pattern as
// product-surface.test.ts), status language from local badge maps.
import { workspaceNav, workspaceNavOrder } from "../app/lib/nav"

const readAppFile = async (rel: string) => {
  const fs = await import("node:fs")
  return fs.readFileSync(new URL(`../app/${rel}`, import.meta.url), "utf8")
}

const readContractsFile = async () => {
  const fs = await import("node:fs")
  return fs.readFileSync(new URL("../../../packages/contracts/src/index.ts", import.meta.url), "utf8")
}

describe("candidate tracking is deliberate action only", () => {
  it("offers Track with explicit configuration, never auto-tracking", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    for (const copy of ["Track", "Track this source", "discovery never tracks anything by itself", "Track source", "Representations.createTarget", "Representations.createBinding"]) {
      expect(page, `missing copy: ${copy}`).toContain(copy)
    }
    const api = await readAppFile("lib/api.ts")
    // The client builds these URLs from the shared contract table, which
    // must carry the exact server paths (single source of truth).
    expect(api).toContain("Routes.createSourceTarget")
    expect(api).toContain("Routes.createSourceBinding")
    const contracts = await readContractsFile()
    expect(contracts).toContain("representations/targets")
    expect(contracts).toContain("/bindings")
  })
})

describe("discovery route", () => {
  it("lives under representations without a new sidebar section", async () => {
    const main = await readAppFile("main.tsx")
    expect(main).toContain('path="representations/discovery"')
    expect(main).toContain("DiscoveryPage")
    expect(workspaceNavOrder).toEqual(["overview", "issues", "representations", "truth", "checks"])
    expect(workspaceNav("/businesses/b1").map((i) => i.id)).toEqual(workspaceNavOrder)
  })

  it("breadcrumbs special-case discovery like the representation detail", async () => {
    const shell = await readAppFile("components/app-shell.tsx")
    expect(shell).toContain('detail === "discovery"')
    expect(shell).toContain("Discovery")
  })

  it("representations page links out without touching finding filters", async () => {
    const fs = await import("node:fs")
    const list = fs.readFileSync(new URL("../app/routes/representations.tsx", import.meta.url), "utf8")
    expect(list).toContain("Discover sources")
    expect(list).toContain("representations/discovery")
  })
})

describe("discovery scopes", () => {
  it("adds an owned site scope with honest ownership copy", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    expect(page).toContain("Add owned site")
    expect(page).toContain("Ghostping scans only this explicitly configured site scope.")
    expect(page).toContain("Marked as owned by the operator.")
    expect(page).not.toContain("Ownership verified")
  })
})

describe("discovery runs", () => {
  it("shows queued/running/completed/partial/failed with concrete counts", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    for (const label of ["Queued", "Running", "Completed", "Partial", "Failed"]) {
      expect(page).toContain(label)
    }
    expect(page).toContain("SUCCEEDED")
    expect(page).toContain("Pages checked")
    expect(page).toContain("Pages skipped")
    expect(page).toContain("Candidates found")
    expect(page).toContain("Scan site")
  })

  it("never renders fake progress percentages", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    expect(page).not.toContain("%")
  })

  it("shows the partial reason and blocks duplicate triggers while active", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    expect(page).toContain("partial_reason")
    expect(page).toContain("Scan stopped early")
    expect(page).toContain("isActive")
    expect(page).toContain("409")
  })
})

describe("discovery candidates", () => {
  it("renders the candidate table with approved/match provenance columns", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    for (const col of ["Approved fact", "Approved value", "Found value", "Page", "Match", "Found via", "Last scan"]) {
      expect(page).toContain(col)
    }
    expect(page).toContain("Open page")
    expect(page).toContain("View truth")
  })

  it("shows why each candidate matched with locator and snippet evidence", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    expect(page).toContain("c.evidence")
    expect(page).toContain("e.locator")
    expect(page).toContain("e.snippet")
    expect(page).toContain("text-muted-foreground")
  })

  it("types candidate evidence with surface, locator, snippet, and relation", async () => {
    const api = await readAppFile("lib/api.ts")
    expect(api).toContain("DiscoveryCandidateEvidence")
    expect(api).toContain("evidence")
    expect(api).toContain("locator")
    expect(api).toContain("snippet")
  })

  it("labels matches current/historical/multiple, never drift or in-sync", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    for (const label of ["Current value found", "Historical value found", "Multiple known values"]) {
      expect(page).toContain(label)
    }
    expect(page).toContain("Historical value found")
    expect(page).not.toContain("Drift")
    expect(page).not.toContain("In sync")
    expect(page).not.toContain("in sync")
  })

  it("warns that a candidate is not a tracked representation", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    expect(page.replace(/\s+/g, " ")).toContain(
      "Discovery finds pages that appear to contain known fact values. A candidate is not a tracked representation until it is explicitly configured.",
    )
  })

  it("bounds its claims to what the scan reached", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    expect(page).toContain("in this scan.")
    expect(page).toContain("Ghostping found {latest.candidates_found}")
    expect(page).toContain('candidate" : "candidates"')
    expect(page).not.toContain("candidate pages")
    expect(page).not.toContain("exhaustive")
    expect(page).not.toContain("coverage")
  })

  it("uses singular/plural candidate copy for one and many", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    expect(page.replace(/\s+/g, " ")).toContain(
      "Ghostping found {latest.candidates_found} {latest.candidates_found === 1 ? \"candidate\" : \"candidates\"} in this scan.",
    )
  })

  it("warns and offers a rescan when truth changed since the scan", async () => {
    const page = await readAppFile("routes/discovery.tsx")
    expect(page).toContain("truth_changed_since_scan")
    expect(page).toContain("Approved truth changed since this scan")
    expect(page).toContain("Rescan site")
  })
})

describe("discovery api client", () => {
  it("exposes scopes, runs, and candidates calls", async () => {
    const api = await readAppFile("lib/api.ts")
    for (const fn of ["listScopes", "createScope", "listRuns", "triggerRun", "listCandidates"]) {
      expect(api).toContain(fn)
    }
    for (const route of ["Routes.listDiscoveryScopes", "Routes.createDiscoveryScope", "Routes.listDiscoveryRuns", "Routes.createDiscoveryRun", "Routes.listDiscoveryCandidates"]) {
      expect(api).toContain(route)
    }
    const contracts = await readContractsFile()
    expect(contracts).toContain("discovery/scopes")
    expect(contracts).toContain("discovery/runs")
    expect(contracts).toContain("discovery/candidates")
  })
})

describe("discovery language guards", () => {
  it("rejects score, publication, causality, and ownership-proof phrases", async () => {
    const fs = await import("node:fs")
    const page = fs.readFileSync(new URL("../app/routes/discovery.tsx", import.meta.url), "utf8")
    const api = fs.readFileSync(new URL("../app/lib/api.ts", import.meta.url), "utf8")
    for (const text of [page, api]) {
      const lower = text.toLowerCase()
      for (const banned of ["score", "published", "caused_by", "caused the"]) {
        expect(lower, `banned phrase: ${banned}`).not.toContain(banned)
      }
    }
    expect(page).not.toContain("Ownership verified")
  })
})
