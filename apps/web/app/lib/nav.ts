// Workspace navigation: single source of truth for sidebar order, labels,
// routes, and breadcrumbs. Tested in tests/product-surface.test.ts.
export interface WorkspaceNavItem {
  readonly id: "overview" | "issues" | "representations" | "truth" | "checks"
  readonly label: string
  readonly path: string
  readonly icon: "overview" | "issues" | "representations" | "truth" | "checks"
}

// Operational workflow comes before the measurement instrument.
export const workspaceNavOrder: ReadonlyArray<WorkspaceNavItem["id"]> = ["overview", "issues", "representations", "truth", "checks"]

export const workspaceNav = (base: string): WorkspaceNavItem[] => [
  { id: "overview", label: "Overview", path: `${base}/overview`, icon: "overview" },
  { id: "issues", label: "Issues", path: `${base}/issues`, icon: "issues" },
  { id: "representations", label: "Representations", path: `${base}/representations`, icon: "representations" },
  { id: "truth", label: "Truth", path: `${base}/truth`, icon: "truth" },
  { id: "checks", label: "Checks", path: `${base}/checks`, icon: "checks" },
]

export const sectionTitles: Record<string, string> = {
  overview: "Overview",
  issues: "Issues",
  representations: "Representations",
  truth: "Truth",
  checks: "Checks",
  facts: "Truth",
}

export type RepresentationFilter = "ALL" | "IN_SYNC" | "DRIFT" | "UNKNOWN"

export const representationFilters: ReadonlyArray<RepresentationFilter> = ["ALL", "DRIFT", "UNKNOWN", "IN_SYNC"]

export const representationFilterLabels: Record<RepresentationFilter, string> = {
  ALL: "All",
  DRIFT: "Drift",
  UNKNOWN: "Unknown",
  IN_SYNC: "In sync",
}
