// robots.txt handling V1: parse, allow-check, and fetch via an injected
// SafeHttpFetcher. No direct network access here.
// Outcomes: 200 -> parse; 404/410 -> no file (allow all); 401/403 ->
// ROBOTS_DENIED (no crawl); 5xx/network -> ROBOTS_UNAVAILABLE (fail-closed).

import { DISCOVERY_BUDGETS_V1 } from "./types.js"

export const DISCOVERY_USER_AGENT = "GhostpingDiscovery/1.0"

export interface RobotsRules {
  readonly disallows: ReadonlyArray<string>
  readonly crawlDelayMs: number | null
  readonly sitemaps: ReadonlyArray<string>
}

export interface SafeHttpFetcher {
  fetch(
    url: string,
    opts: {
      readonly byteCeiling: number
      readonly acceptedContentTypes: ReadonlyArray<string>
      readonly userAgent: string
      readonly timeoutMs: number
    },
  ): Promise<{
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly body: Uint8Array
    readonly finalUrl: string
  }>
}

export type RobotsOutcome =
  | { readonly state: "PARSED"; readonly rules: RobotsRules }
  | { readonly state: "NO_FILE"; readonly rules: RobotsRules }
  | { readonly state: "DENIED" }
  | { readonly state: "UNAVAILABLE"; readonly detail: string }

const ALLOW_ALL: RobotsRules = { disallows: [], crawlDelayMs: null, sitemaps: [] }

/** Parse robots.txt for our user agents. Pure and deterministic. */
export const parseRobots = (txt: string, userAgents: ReadonlyArray<string> = ["GhostpingDiscovery", "*"]): RobotsRules => {
  const ours = userAgents.map((a) => a.toLowerCase())
  interface Group {
    agents: string[]
    disallows: string[]
    crawlDelayMs: number | null
  }
  const groups: Group[] = []
  let current: Group | null = null
  let sawRuleInGroup = false
  const sitemaps: string[] = []

  const matchesUs = (agents: ReadonlyArray<string>): boolean =>
    agents.some((g) => {
      const gl = g.toLowerCase()
      if (gl === "*") return true
      return ours.some((o) => o === gl || o.startsWith(gl))
    })

  for (const rawLine of txt.split(/\r?\n/)) {
    const noComment = rawLine.split("#")[0] ?? ""
    const line = noComment.trim()
    if (line === "") continue
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === "user-agent") {
      if (sawRuleInGroup) {
        current = null
        sawRuleInGroup = false
      }
      if (current === null) {
        current = { agents: [], disallows: [], crawlDelayMs: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
    } else if (field === "disallow") {
      if (current === null) continue
      sawRuleInGroup = true
      // Empty Disallow means allow-all: record nothing.
      if (value !== "") current.disallows.push(value.split(/\s/)[0] ?? "")
    } else if (field === "crawl-delay") {
      if (current === null) continue
      sawRuleInGroup = true
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds >= 0) {
        const ms = Math.round(seconds * 1000)
        current.crawlDelayMs = current.crawlDelayMs === null ? ms : Math.max(current.crawlDelayMs, ms)
      }
    } else if (field === "sitemap") {
      // Sitemap directives are global, independent of user-agent groups.
      if (value !== "") sitemaps.push(value.split(/\s/)[0] ?? "")
    }
    // Allow and all other directives are ignored in V1 (fail-closed via Disallow only).
  }

  const disallows: string[] = []
  let crawlDelayMs: number | null = null
  for (const g of groups) {
    if (!matchesUs(g.agents)) continue
    for (const d of g.disallows) {
      if (!disallows.includes(d)) disallows.push(d)
    }
    if (g.crawlDelayMs !== null) {
      crawlDelayMs = crawlDelayMs === null ? g.crawlDelayMs : Math.max(crawlDelayMs, g.crawlDelayMs)
    }
  }
  disallows.sort()
  const dedupedSitemaps = [...new Set(sitemaps)].sort()
  return { disallows, crawlDelayMs, sitemaps: dedupedSitemaps }
}

/** Path allow-check: any matching Disallow prefix denies. Empty rules allow all. */
export const isAllowed = (path: string, rules: RobotsRules): boolean => {
  const target = path === "" ? "/" : path
  for (const d of rules.disallows) {
    if (d === "") continue
    if (d === "/") return false
    if (target.startsWith(d)) return false
  }
  return true
}

/** Effective per-request delay: robots crawl-delay when present, else the V1 floor. */
export const effectiveCrawlDelayMs = (
  rules: RobotsRules,
  floorMs: number = DISCOVERY_BUDGETS_V1.crawlDelayMs,
): number => (rules.crawlDelayMs !== null ? Math.max(rules.crawlDelayMs, 0) : floorMs)

/** True when the outcome forbids crawling (deny or fail-closed unavailable). */
export const isCrawlForbidden = (outcome: RobotsOutcome): boolean =>
  outcome.state === "DENIED" || outcome.state === "UNAVAILABLE"

export const fetchAndParseRobots = async (
  origin: string,
  fetcher: SafeHttpFetcher,
  userAgents: ReadonlyArray<string> = ["GhostpingDiscovery", "*"],
): Promise<RobotsOutcome> => {
  const url = `${origin}/robots.txt`
  let res: Awaited<ReturnType<SafeHttpFetcher["fetch"]>>
  try {
    res = await fetcher.fetch(url, {
      byteCeiling: DISCOVERY_BUDGETS_V1.robotsBytes,
      acceptedContentTypes: ["text/plain"],
      userAgent: DISCOVERY_USER_AGENT,
      timeoutMs: 8000,
    })
  } catch {
    return { state: "UNAVAILABLE", detail: "NETWORK_ERROR" }
  }
  if (res.status === 404 || res.status === 410) return { state: "NO_FILE", rules: ALLOW_ALL }
  if (res.status === 401 || res.status === 403) return { state: "DENIED" }
  if (res.status >= 500 && res.status <= 599) return { state: "UNAVAILABLE", detail: `HTTP_${res.status}` }
  if (res.status < 200 || res.status >= 300) {
    // 429 and other 4xx (outside 401/403/404/410): fail closed, retryable upstream.
    return { state: "UNAVAILABLE", detail: `HTTP_${res.status}` }
  }
  const capped =
    res.body.length > DISCOVERY_BUDGETS_V1.robotsBytes
      ? res.body.slice(0, DISCOVERY_BUDGETS_V1.robotsBytes)
      : res.body
  const text = Buffer.from(capped).toString("utf8")
  return { state: "PARSED", rules: parseRobots(text, userAgents) }
}
