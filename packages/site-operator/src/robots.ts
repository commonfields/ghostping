// robots.txt parsing: deterministic, no network.
// Supports User-agent groups, Disallow/Allow, Sitemap directives.
// Group matching: exact token match on "*" plus prefix product-token match.
export interface RobotsRules {
  readonly disallows: ReadonlyArray<string>
  readonly allows: ReadonlyArray<string>
  readonly sitemaps: ReadonlyArray<string>
  readonly crawlDelayMs: number | null
}

export const parseRobotsTxt = (text: string): RobotsRules => {
  const disallows: string[] = []
  const allows: string[] = []
  const sitemaps: string[] = []
  let crawlDelayMs: number | null = null
  let inRelevantGroup = false
  let seenUserAgent = false
  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.split("#")[0]?.trim() ?? ""
    if (!line) continue
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === "user-agent") {
      const token = value.toLowerCase()
      // A new group starts at each user-agent line following rules.
      if (seenUserAgent && (disallows.length > 0 || allows.length > 0 || crawlDelayMs !== null)) {
        // Heuristic group boundary: reset relevance for the new group.
        inRelevantGroup = token === "*" || token === "ghostping" || token.startsWith("ghostping")
        seenUserAgent = true
        continue
      }
      seenUserAgent = true
      if (token === "*" || token === "ghostping" || "ghostping".startsWith(token) || token.startsWith("ghostping")) {
        inRelevantGroup = true
      } else if (!inRelevantGroup) {
        // stay out until a relevant group appears
      }
      continue
    }
    if (field === "sitemap") {
      if (value) sitemaps.push(value)
      continue
    }
    if (!inRelevantGroup && seenUserAgent) continue
    if (field === "disallow") {
      if (value) disallows.push(value)
      continue
    }
    if (field === "allow") {
      if (value) allows.push(value)
      continue
    }
    if (field === "crawl-delay") {
      const n = Number(value)
      if (Number.isFinite(n) && n >= 0) crawlDelayMs = Math.min(n * 1000, 30_000)
      continue
    }
  }
  return { disallows, allows, sitemaps, crawlDelayMs }
}

/** Longest-prefix match: Allow wins ties at equal length. */
export const isAllowedByRobots = (pathWithQuery: string, rules: RobotsRules): boolean => {
  let bestAllow = -1
  let bestDisallow = -1
  for (const a of rules.allows) {
    if (a && pathWithQuery.startsWith(a)) bestAllow = Math.max(bestAllow, a.length)
  }
  for (const d of rules.disallows) {
    if (d && pathWithQuery.startsWith(d)) bestDisallow = Math.max(bestDisallow, d.length)
  }
  if (bestDisallow === -1) return true
  if (bestAllow === -1) return false
  return bestAllow >= bestDisallow
}

export const isUrlAllowedByRobots = (url: string, rules: RobotsRules): boolean => {
  try {
    const u = new URL(url)
    return isAllowedByRobots(`${u.pathname}${u.search}`, rules)
  } catch {
    return false
  }
}
