// Representation Discovery V1 core: deterministic, no LLM, no network.
// Orchestration owns fetching; these modules are pure except for the
// injected SafeHttpFetcher seam used by robots/sitemap helpers.

export const MATCHER_VERSION = "discovery-matcher/1"
export const POLICY_VERSION = "discovery-policy/1"

/** Frozen V1 budget snapshot, persisted per run. */
export const DISCOVERY_BUDGETS_V1 = {
  maxPages: 250,
  hardPageCap: 1000,
  linkDepth: 2,
  sitemapDocs: 20,
  sitemapEntries: 10000,
  sitemapDecompressedBytes: 5 * 1024 * 1024,
  robotsBytes: 256 * 1024,
  pageBytes: 1000000,
  concurrency: 2,
  wallClockMs: 600000,
  crawlDelayMs: 200,
} as const

export type DiscoveryRunState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED"

export type ResourceKind = "ROBOTS" | "SITEMAP" | "PAGE"

export type DiscoveredVia = "ROOT" | "ROBOTS_SITEMAP" | "DEFAULT_SITEMAP" | "SITEMAP" | "LINK"

export type DiscoveryCollectionState = "FETCHED" | "NOT_MODIFIED" | "FAILED"

export type DiscoveryFailure =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "SECURITY_REJECTED"
  | "INVALID_URL"
  | "REDIRECT_LIMIT"
  | "RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "HTTP_ERROR"
  | "ROBOTS_DENIED"
  | "ROBOTS_UNAVAILABLE"

export type SkipReason =
  | "DUPLICATE"
  | "INVALID_URL"
  | "OUT_OF_SCOPE"
  | "OUT_OF_SCOPE_REDIRECT"
  | "QUERY_LINK_SKIPPED"
  | "DEPTH_EXCEEDED"
  | "ROBOTS_DISALLOWED"
  | "ROBOTS_DENIED"
  | "BUDGET_EXHAUSTED"

export interface DiscoveryScopeV1 {
  readonly id: string
  readonly business_id: string
  readonly root_url: string
  readonly canonical_origin: string
  readonly path_prefix: string
  readonly enabled: boolean
  readonly ownership_assertion: "OPERATOR_ASSERTED_OWNED"
  readonly created_at: string
}

export interface DiscoveryFetchObservation {
  readonly resource_kind: ResourceKind
  readonly requested_url: string
  readonly canonical_url: string | null
  readonly final_url: string
  readonly discovered_via: DiscoveredVia
  readonly parent_url: string | null
  readonly depth: number
  readonly http_status: number | null
  readonly content_type: string | null
  readonly etag: string | null
  readonly last_modified: string | null
  readonly body_digest: string | null
  readonly body_bytes: number
  readonly collection_state: DiscoveryCollectionState
  readonly failure: DiscoveryFailure | null
}

export type DiscoveryMatchSurface = "JSON_LD" | "META" | "VISIBLE_TEXT"

export type DiscoveryMatchRelation = "CURRENT_VALUE" | "HISTORICAL_VALUE"

export interface DiscoveryMatch {
  readonly run_id: string
  readonly page_observation_id: string
  readonly lineage_root: string
  readonly matched_fact: string
  readonly matched_version: number
  readonly matched_value: string
  readonly surface: DiscoveryMatchSurface
  readonly locator: string
  readonly snippet: string
  readonly relation: DiscoveryMatchRelation
  readonly matcher_version: string
}

export type CandidateState = "CURRENT_VALUE_FOUND" | "HISTORICAL_VALUE_FOUND" | "MIXED_KNOWN_VALUES"

export interface CandidateSummary {
  readonly page_url: string
  readonly lineage_root: string
  readonly state: CandidateState
  readonly current_match: DiscoveryMatch | null
  readonly historical_matches: ReadonlyArray<DiscoveryMatch>
}
