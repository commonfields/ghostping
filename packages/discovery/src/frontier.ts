// Deterministic in-memory frontier V1. Pure functions: lexicographic order,
// dedupe by normalizeUrl (fragment dropped, query kept), depth tracking,
// query-by-provenance gating, scope enforcement, page-budget exhaustion.

import { normalizeUrl } from "@openrecord/representation"
import { DISCOVERY_BUDGETS_V1, type DiscoveredVia, type SkipReason } from "./types.js"
import { isInScope, isQueryAllowed } from "./policy.js"

export interface FrontierInput {
  readonly url: string
  readonly discoveredVia: DiscoveredVia
  readonly parentUrl: string | null
  readonly depth: number
}

export interface FrontierEntry {
  readonly canonicalUrl: string
  readonly requestedUrl: string
  readonly discoveredVia: DiscoveredVia
  readonly parentUrl: string | null
  readonly depth: number
  readonly orderKey: number
}

export interface SkippedUrl {
  readonly url: string
  readonly reason: SkipReason
}

export interface BuiltFrontier {
  readonly entries: ReadonlyArray<FrontierEntry>
  readonly skipped: ReadonlyArray<SkippedUrl>
  readonly partial: boolean
}

export interface FrontierScope {
  readonly canonical_origin: string
  readonly path_prefix: string
}

const VIA_PRIORITY: Record<DiscoveredVia, number> = {
  ROOT: 0,
  ROBOTS_SITEMAP: 1,
  DEFAULT_SITEMAP: 2,
  SITEMAP: 3,
  LINK: 4,
}

/**
 * Build a deterministic crawl frontier. Sitemap-sourced URLs carry no depth
 * limit; LINK URLs beyond linkDepth are skipped with DEPTH_EXCEEDED.
 * Output entries are sorted lexicographically with stable order keys;
 * overflow past maxPages is skipped BUDGET_EXHAUSTED and marks PARTIAL.
 */
export const buildFrontier = (args: {
  readonly scope: FrontierScope
  readonly candidates: ReadonlyArray<FrontierInput>
  readonly maxPages?: number
}): BuiltFrontier => {
  const maxPages = args.maxPages ?? DISCOVERY_BUDGETS_V1.maxPages
  const skipped: SkippedUrl[] = []
  const byCanonical = new Map<string, FrontierInput & { requestedUrl: string }>()

  for (const c of args.candidates) {
    const canonical = normalizeUrl(c.url)
    if (canonical === null) {
      skipped.push({ url: c.url, reason: "INVALID_URL" })
      continue
    }
    if (!isInScope(canonical, args.scope)) {
      skipped.push({ url: c.url, reason: "OUT_OF_SCOPE" })
      continue
    }
    if (!isQueryAllowed(canonical, c.discoveredVia)) {
      skipped.push({ url: c.url, reason: "QUERY_LINK_SKIPPED" })
      continue
    }
    if (c.discoveredVia === "LINK" && c.depth > DISCOVERY_BUDGETS_V1.linkDepth) {
      skipped.push({ url: c.url, reason: "DEPTH_EXCEEDED" })
      continue
    }
    const prior = byCanonical.get(canonical)
    if (prior === undefined) {
      byCanonical.set(canonical, { ...c, requestedUrl: c.url })
    } else {
      // Deterministic merge: keep the highest-priority provenance, then the
      // shallowest depth, then the lexicographically smallest parent.
      const keepNext =
        VIA_PRIORITY[c.discoveredVia] < VIA_PRIORITY[prior.discoveredVia] ||
        (c.discoveredVia === prior.discoveredVia &&
          (c.depth < prior.depth ||
            (c.depth === prior.depth && String(c.parentUrl ?? "") < String(prior.parentUrl ?? ""))))
      if (keepNext) byCanonical.set(canonical, { ...c, requestedUrl: c.url })
      else skipped.push({ url: c.url, reason: "DUPLICATE" })
    }
  }

  const sorted = [...byCanonical.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const entries: FrontierEntry[] = sorted.map(([canonical, c], i) => ({
    canonicalUrl: canonical,
    requestedUrl: c.requestedUrl,
    discoveredVia: c.discoveredVia,
    parentUrl: c.parentUrl,
    depth: c.discoveredVia === "LINK" ? c.depth : 0,
    orderKey: i,
  }))

  let partial = false
  let kept = entries
  if (entries.length > maxPages) {
    kept = entries.slice(0, maxPages)
    for (const e of entries.slice(maxPages)) skipped.push({ url: e.requestedUrl, reason: "BUDGET_EXHAUSTED" })
    partial = true
  }
  skipped.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
  return { entries: kept, skipped, partial }
}

/** Redirect target check: same-origin+prefix or OUT_OF_SCOPE_REDIRECT. */
export const classifyRedirect = (
  finalUrl: string,
  scope: FrontierScope,
): { readonly ok: true } | { readonly ok: false; readonly reason: "OUT_OF_SCOPE_REDIRECT" } => {
  const canonical = normalizeUrl(finalUrl)
  if (canonical === null || !isInScope(canonical, scope)) return { ok: false, reason: "OUT_OF_SCOPE_REDIRECT" }
  return { ok: true }
}
