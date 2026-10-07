// SEARCH_OPERATOR_V1 domain vocabulary.
//
// Concrete language only: findings name observable problems, never scores.
// Indexability (what OpenRecord observed about crawl/index directives) is
// distinct from Google-reported indexing (what Search Console reports).
// The two are never interchangeable.

export const INSPECTOR_VERSION = "site-inspector/1"
export const POLICY_VERSION = "site-operator-policy/1"

export type Indexability =
  | "INDEXABLE"
  | "BLOCKED_BY_META"
  | "BLOCKED_BY_HEADER"
  | "BLOCKED_BY_ROBOTS"
  | "REDIRECTED"
  | "NOT_FOUND"
  | "SERVER_ERROR"
  | "CANONICALIZED_ELSEWHERE"
  | "RENDERING_FAILURE"
  | "UNKNOWN"

export type FindingKind =
  | "BLOCKED_BY_META"
  | "BLOCKED_BY_HEADER"
  | "BLOCKED_BY_ROBOTS"
  | "NOT_FOUND"
  | "SERVER_ERROR"
  | "REDIRECT_LOOP"
  | "REDIRECT_CHAIN_LONG"
  | "BROKEN_CANONICAL"
  | "CANONICALIZED_ELSEWHERE"
  | "MISSING_TITLE"
  | "MISSING_DESCRIPTION"
  | "MISSING_H1"
  | "BROKEN_INTERNAL_LINK"
  | "POSSIBLE_ORPHAN"
  | "INVALID_STRUCTURED_DATA"
  | "MISSING_ALT"
  | "RENDER_DISCREPANCY"
  | "SITEMAP_INVALID"
  | "SITEMAP_MISSING"
  | "ROBOTS_BLOCKS_IMPORTANT"

export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"

export type FindingStatus =
  | "OPEN"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "FIX_IN_PROGRESS"
  | "FIX_APPLIED"
  | "VERIFICATION_PENDING"
  | "VERIFIED_FIXED"
  | "VERIFIED_NOT_FIXED"
  | "DISMISSED"
  | "UNKNOWN"

export type FindingConfidence = "HIGH" | "MEDIUM" | "LOW"

export type FindingCategory =
  | "CRAWL_INDEX_RISK"
  | "USABILITY_ACCESSIBILITY"
  | "SEARCH_PRESENTATION"
  | "CONTENT_OPPORTUNITY"
  | "INFORMATIONAL"

export type InspectionRunState =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "PARTIALLY_SUCCEEDED"
  | "FAILED"

export type InspectionFailure =
  | "DNS_FAILURE"
  | "CONNECT_TIMEOUT"
  | "TLS_FAILURE"
  | "HTTP_FAILURE"
  | "ROBOTS_PARSE_FAILURE"
  | "SITEMAP_PARSE_FAILURE"
  | "RENDER_FAILURE"
  | "CRAWL_LIMIT_REACHED"
  | "TARGET_BLOCKED"
  | "ADAPTER_FAILURE"
  | "MUTATION_FAILURE"
  | "VERIFICATION_FAILURE"
  | "INVALID_SCOPE"
  | "FETCH_FAILED"
  | "RUNNER_ERROR"

export type FixClassification = "SAFE_AUTOMATIC" | "APPROVAL_REQUIRED" | "MANUAL_ONLY"

export type FixKind =
  | "REMOVE_NOINDEX_META"
  | "FIX_CANONICAL"
  | "REPAIR_SITEMAP"
  | "FIX_INTERNAL_LINK"
  | "ADD_TITLE"
  | "ADD_DESCRIPTION"
  | "ADD_ALT"
  | "FIX_STRUCTURED_DATA"
  | "MANUAL_ONLY"

export type FixProposalStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "SUPERSEDED"

export type MutationState =
  | "CREATED"
  | "BRANCH_CREATED"
  | "PR_OPEN"
  | "MERGED"
  | "FAILED"

export type VerificationResult =
  | "VERIFICATION_PENDING"
  | "VERIFIED_FIXED"
  | "VERIFIED_NOT_FIXED"

export interface PageEvidence {
  readonly url: string
  readonly finalUrl: string
  readonly status: number | null
  readonly contentType: string | null
  readonly redirectChain: ReadonlyArray<string>
  readonly headers: Record<string, string>
  readonly robotsMeta: string | null
  readonly xRobotsTag: string | null
  readonly canonical: string | null
  readonly title: string | null
  readonly metaDescription: string | null
  readonly h1Present: boolean
  readonly h1Count: number
  readonly internalLinks: ReadonlyArray<string>
  readonly brokenInternalLinks: ReadonlyArray<string>
  readonly imagesMissingAlt: number
  readonly imagesTotal: number
  readonly jsonLdBlocks: ReadonlyArray<{ raw: string; valid: boolean; error: string | null }>
  readonly bodyDigest: string | null
  readonly bodyBytes: number
  readonly failure: string | null
}

export interface DerivedFinding {
  readonly findingKind: FindingKind
  readonly severity: FindingSeverity
  readonly category: FindingCategory
  readonly url: string
  readonly evidence: Record<string, unknown>
  readonly diagnosis: string
  readonly recommendedAction: string
  readonly confidence: FindingConfidence
}

export interface ClassifiedPage {
  readonly evidence: PageEvidence
  readonly indexability: Indexability
  readonly findings: ReadonlyArray<DerivedFinding>
}

export const FINDING_KIND_META: Record<FindingKind, { severity: FindingSeverity; category: FindingCategory }> = {
  BLOCKED_BY_META: { severity: "HIGH", category: "CRAWL_INDEX_RISK" },
  BLOCKED_BY_HEADER: { severity: "HIGH", category: "CRAWL_INDEX_RISK" },
  BLOCKED_BY_ROBOTS: { severity: "CRITICAL", category: "CRAWL_INDEX_RISK" },
  NOT_FOUND: { severity: "HIGH", category: "CRAWL_INDEX_RISK" },
  SERVER_ERROR: { severity: "CRITICAL", category: "CRAWL_INDEX_RISK" },
  REDIRECT_LOOP: { severity: "HIGH", category: "CRAWL_INDEX_RISK" },
  REDIRECT_CHAIN_LONG: { severity: "MEDIUM", category: "CRAWL_INDEX_RISK" },
  BROKEN_CANONICAL: { severity: "HIGH", category: "CRAWL_INDEX_RISK" },
  CANONICALIZED_ELSEWHERE: { severity: "HIGH", category: "CRAWL_INDEX_RISK" },
  MISSING_TITLE: { severity: "MEDIUM", category: "SEARCH_PRESENTATION" },
  MISSING_DESCRIPTION: { severity: "LOW", category: "SEARCH_PRESENTATION" },
  MISSING_H1: { severity: "LOW", category: "CONTENT_OPPORTUNITY" },
  BROKEN_INTERNAL_LINK: { severity: "MEDIUM", category: "CRAWL_INDEX_RISK" },
  POSSIBLE_ORPHAN: { severity: "MEDIUM", category: "CRAWL_INDEX_RISK" },
  INVALID_STRUCTURED_DATA: { severity: "MEDIUM", category: "SEARCH_PRESENTATION" },
  MISSING_ALT: { severity: "LOW", category: "USABILITY_ACCESSIBILITY" },
  RENDER_DISCREPANCY: { severity: "MEDIUM", category: "INFORMATIONAL" },
  SITEMAP_INVALID: { severity: "HIGH", category: "CRAWL_INDEX_RISK" },
  SITEMAP_MISSING: { severity: "LOW", category: "INFORMATIONAL" },
  ROBOTS_BLOCKS_IMPORTANT: { severity: "CRITICAL", category: "CRAWL_INDEX_RISK" },
}

export const canTransitionFinding = (from: FindingStatus, to: FindingStatus): boolean => {
  const allowed: Record<FindingStatus, ReadonlyArray<FindingStatus>> = {
    OPEN: ["AWAITING_APPROVAL", "DISMISSED", "UNKNOWN"],
    AWAITING_APPROVAL: ["APPROVED", "DISMISSED", "OPEN"],
    APPROVED: ["FIX_IN_PROGRESS", "DISMISSED", "OPEN"],
    FIX_IN_PROGRESS: ["FIX_APPLIED", "OPEN"],
    FIX_APPLIED: ["VERIFICATION_PENDING"],
    VERIFICATION_PENDING: ["VERIFIED_FIXED", "VERIFIED_NOT_FIXED"],
    VERIFIED_FIXED: ["OPEN"],
    VERIFIED_NOT_FIXED: ["OPEN", "AWAITING_APPROVAL"],
    DISMISSED: ["OPEN"],
    UNKNOWN: ["OPEN", "DISMISSED"],
  }
  return (allowed[from] ?? []).includes(to)
}

export const canTransitionRun = (from: InspectionRunState, to: InspectionRunState): boolean => {
  switch (from) {
    case "QUEUED":
      return to === "RUNNING"
    case "RUNNING":
      return to === "SUCCEEDED" || to === "PARTIALLY_SUCCEEDED" || to === "FAILED"
    case "SUCCEEDED":
    case "PARTIALLY_SUCCEEDED":
    case "FAILED":
      return false
  }
}

export const SITE_INSPECTION_BUDGETS = {
  maxUrls: 50,
  maxBytes: 1_000_000,
  timeoutMs: 8000,
  maxRedirects: 5,
  maxConcurrency: 4,
  sitemapDocs: 10,
  sitemapEntries: 5000,
  sitemapMaxDepth: 3,
  wallClockMs: 120_000,
} as const
