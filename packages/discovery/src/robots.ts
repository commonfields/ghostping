// robots.txt handling V1: parse, allow-check, and fetch via an injected
// SafeHttpFetcher. No direct network access here.
// Outcomes: 200 -> parse; 404/410 -> no file (allow all); 401/403 ->
// ROBOTS_DENIED (no crawl); 5xx/network -> ROBOTS_UNAVAILABLE (fail-closed).

import { DISCOVERY_BUDGETS_V1 } from "./types.js"

export const DISCOVERY_USER_AGENT = "GhostpingDiscovery/1.0"

export interface RobotsRules {
  readonly disallows: ReadonlyArray<string>
  readonly allows?: ReadonlyArray<string>
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

export interface FetchRobotsOptions {
  readonly scopeOrigin?: string | null
  readonly allowCrossOrigin?: boolean
}

export type RobotsOutcome =
  | { readonly state: "PARSED"; readonly rules: RobotsRules }
  | { readonly state: "NO_FILE"; readonly rules: RobotsRules }
  | { readonly state: "DENIED" }
  | { readonly state: "UNAVAILABLE"; readonly detail: string }

const ALLOW_ALL: RobotsRules = { disallows: [], allows: [], crawlDelayMs: null, sitemaps: [] }

const originOf = (u: string): string | null => {
  try {
    return new URL(u).origin
  } catch {
    return null
  }
}

/**
 * Google-style robots path matching with `*` wildcard and `$` end anchor.
 * Returns true when the pattern matches the target path.
 * Unparseable patterns never match (conservative: never allow-all, never
 * deny-all by accident).
 */
const robotsPatternMatches = (pattern: string, target: string): boolean => {
  if (pattern === "") return false
  if (!pattern.startsWith("/") && !pattern.startsWith("*")) return false
  const anchored = pattern.endsWith("$")
  const core = anchored ? pattern.slice(0, -1) : pattern
  if (core === "") return false
  if (core.includes("$")) return false
  let src = "^"
  for (const ch of core) {
    if (ch === "*") {
      src += ".*"
    } else if (ch === "/") {
      src += "/"
    } else if ("\\^.+?()[]{}|".includes(ch)) {
      src += `\\${ch}`
    } else {
      src += ch
    }
  }
  if (anchored) src += "$"
  try {
    return new RegExp(src).test(target)
  } catch {
    return false
  }
}

/** Parse robots.txt for our user agents. Pure and deterministic. */
export const parseRobots = (txt: string, userAgents: ReadonlyArray<string> = ["GhostpingDiscovery", "*"]): RobotsRules => {
  const ours = userAgents.map((a) => a.toLowerCase())
  interface Group {
    agents: string[]
    allows: string[]
    disallows: string[]
    crawlDelayMs: number | null
  }
  const groups: Group[] = []
  let current: Group | null = null
  let sawRuleInGroup = false
  const sitemaps: string[] = []

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
        current = { agents: [], allows: [], disallows: [], crawlDelayMs: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
    } else if (field === "disallow") {
      if (current === null) continue
      sawRuleInGroup = true
      // Empty Disallow means allow-all: record nothing.
      if (value !== "") {
        const token = value.split(/\s/)[0] ?? ""
        if (token !== "") current.disallows.push(token)
      }
    } else if (field === "allow") {
      if (current === null) continue
      sawRuleInGroup = true
      // Empty Allow matches nothing: record nothing.
      if (value !== "") {
        const token = value.split(/\s/)[0] ?? ""
        if (token !== "") current.allows.push(token)
      }
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
      if (value !== "") {
        const token = value.split(/\s/)[0] ?? ""
        if (token !== "") sitemaps.push(token)
      }
    }
  }

  // UA group selection: most-specific applicable specific group wins (no union
  // with `*`); otherwise fall back to `*` groups. Crawl-delay comes from the
  // selected group(s) only.
  interface Selected {
    group: Group
    specificity: number
  }
  const specific: Selected[] = []
  const wildcard: Group[] = []
  for (const g of groups) {
    const hasStar = g.agents.includes("*")
    let best: number | null = null
    for (const gl of g.agents) {
      if (gl === "*") continue
      for (const o of ours) {
        if (o === "*") continue
        if (o === gl || o.startsWith(gl)) {
          best = best === null ? gl.length : Math.max(best, gl.length)
        }
      }
    }
    if (best !== null) {
      specific.push({ group: g, specificity: best })
    } else if (hasStar) {
      wildcard.push(g)
    }
  }

  let selectedGroups: Group[]
  if (specific.length > 0) {
    const maxSpec = Math.max(...specific.map((s) => s.specificity))
    selectedGroups = specific.filter((s) => s.specificity === maxSpec).map((s) => s.group)
  } else {
    selectedGroups = wildcard
  }

  const disallows: string[] = []
  const allows: string[] = []
  let crawlDelayMs: number | null = null
  for (const g of selectedGroups) {
    for (const d of g.disallows) {
      if (!disallows.includes(d)) disallows.push(d)
    }
    for (const a of g.allows) {
      if (!allows.includes(a)) allows.push(a)
    }
    if (g.crawlDelayMs !== null) {
      crawlDelayMs = crawlDelayMs === null ? g.crawlDelayMs : Math.max(crawlDelayMs, g.crawlDelayMs)
    }
  }
  disallows.sort()
  allows.sort()
  const dedupedSitemaps = [...new Set(sitemaps)].sort()
  return { disallows, allows, crawlDelayMs, sitemaps: dedupedSitemaps }
}

/**
 * Path allow-check with Allow + Disallow, `*` wildcard, `$` end anchor,
 * longest-match-wins, Allow-wins-ties. Empty rules allow all.
 */
export const isAllowed = (path: string, rules: RobotsRules): boolean => {
  let target = path === "" ? "/" : path
  if (!target.startsWith("/")) target = `/${target}`
  const allows = rules.allows ?? []
  let bestAllow = -1
  let bestDisallow = -1
  for (const a of allows) {
    if (a === "") continue
    if (!robotsPatternMatches(a, target)) continue
    if (a.length > bestAllow) bestAllow = a.length
  }
  for (const d of rules.disallows) {
    if (d === "") continue
    if (!robotsPatternMatches(d, target)) continue
    if (d.length > bestDisallow) bestDisallow = d.length
  }
  if (bestAllow === -1 && bestDisallow === -1) return true
  if (bestAllow === -1) return false
  if (bestDisallow === -1) return true
  return bestAllow >= bestDisallow
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
  opts?: FetchRobotsOptions,
): Promise<RobotsOutcome> => {
  const normalizedOrigin = origin.replace(/\/+$/, "")
  const url = `${normalizedOrigin}/robots.txt`
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
  if (opts?.allowCrossOrigin === false) {
    const finalUrl = res.finalUrl
    if (typeof finalUrl === "string" && finalUrl !== "") {
      const expectedRaw = opts?.scopeOrigin ?? origin
      const expectedOrigin = originOf(expectedRaw) ?? originOf(url)
      const finalOrigin = originOf(finalUrl)
      if (expectedOrigin !== null && finalOrigin !== null && finalOrigin !== expectedOrigin) {
        return { state: "UNAVAILABLE", detail: "OUT_OF_SCOPE_REDIRECT" }
      }
    }
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
