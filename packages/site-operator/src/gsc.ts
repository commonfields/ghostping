// Search Console boundary: provider contract + deterministic fixtures.
// Live Google data is never faked. Without OAuth credentials the provider
// reports blocked status and serves fixture rows labeled as fixtures; the
// core closed loop (inspect -> fix -> verify) never depends on it.
//
// Distinguish SITE_INDEXABLE (OpenRecord-observed directives) from
// GOOGLE_REPORTED_INDEXED (what Google reports). They are not interchangeable.

export type GscConnectionStatus = "CONNECTED" | "BLOCKED_MISSING_CREDENTIALS" | "ERROR"

export interface GscProperty {
  readonly propertyUri: string
  readonly permissionLevel: string
}

export interface GscInspectionReport {
  readonly url: string
  readonly googleReportedIndexed: boolean | null
  readonly coverageState: string | null
  readonly lastCrawledAt: string | null
  readonly source: "LIVE" | "FIXTURE"
}

export interface SearchConsoleProvider {
  readonly name: "google-search-console"
  status(): Promise<{ status: GscConnectionStatus; detail: string }>
  listProperties(): Promise<GscProperty[]>
  inspectUrl(propertyUri: string, url: string): Promise<GscInspectionReport>
}

/** Deterministic fixture provider for tests and offline demos. */
export const FixtureSearchConsoleProvider: SearchConsoleProvider = {
  name: "google-search-console",
  async status() {
    return { status: "BLOCKED_MISSING_CREDENTIALS", detail: "Live Search Console OAuth credentials are not configured; serving labeled fixtures only." }
  },
  async listProperties() {
    return [{ propertyUri: "sc-domain:example.com", permissionLevel: "fixture" }]
  },
  async inspectUrl(_propertyUri, url) {
    return {
      url,
      googleReportedIndexed: null,
      coverageState: "FIXTURE_NOT_CONNECTED",
      lastCrawledAt: null,
      source: "FIXTURE",
    }
  },
}

/** Live provider stub: fails closed without credentials, never fabricates. */
export const makeLiveSearchConsoleProvider = (opts: { credentialsPresent: boolean }): SearchConsoleProvider => ({
  name: "google-search-console",
  async status() {
    if (!opts.credentialsPresent) {
      return { status: "BLOCKED_MISSING_CREDENTIALS", detail: "GOOGLE_SEARCH_CONSOLE_BLOCKED: OAuth/application credentials unavailable. Provider contract is implemented; live integration is deferred." }
    }
    return { status: "CONNECTED", detail: "connected" }
  },
  async listProperties() {
    if (!opts.credentialsPresent) throw new Error("GOOGLE_SEARCH_CONSOLE_BLOCKED: credentials unavailable")
    return []
  },
  async inspectUrl() {
    if (!opts.credentialsPresent) throw new Error("GOOGLE_SEARCH_CONSOLE_BLOCKED: credentials unavailable")
    throw new Error("not implemented: live URL inspection requires Google API access")
  },
})

export const hasLiveSearchConsoleCredentials = (): boolean =>
  Boolean(process.env["GOOGLE_SEARCH_CONSOLE_CLIENT_ID"] && process.env["GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET"])
