// Minimal internal-link graph: inspected pages + sitemap URLs.
// Terminology is deliberately weak: POSSIBLE_ORPHAN unless the crawl was
// exhaustive. A URL absent from a sampled crawl is not globally orphaned.
export interface LinkGraphInput {
  readonly pages: ReadonlyArray<{ url: string; links: ReadonlyArray<string> }>
  readonly sitemapUrls: ReadonlyArray<string>
  readonly origin: string
}

export interface LinkGraph {
  readonly brokenInternal: ReadonlyArray<{ from: string; to: string }>
  readonly possibleOrphans: ReadonlyArray<string>
  readonly knownUrls: Set<string>
}

const normalize = (url: string): string | null => {
  try {
    const u = new URL(url)
    u.hash = ""
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1)
    return u.toString()
  } catch {
    return null
  }
}

export const buildLinkGraph = (
  input: LinkGraphInput,
  opts: { knownStatuses?: Map<string, number | null> } = {},
): LinkGraph => {
  const known = new Set<string>()
  for (const p of input.pages) {
    const n = normalize(p.url)
    if (n) known.add(n)
  }
  const inbound = new Map<string, number>()
  const brokenInternal: Array<{ from: string; to: string }> = []
  for (const p of input.pages) {
    const fromN = normalize(p.url) ?? p.url
    for (const raw of p.links) {
      let target: URL | null = null
      try {
        target = new URL(raw)
      } catch {
        continue
      }
      if (target.origin !== input.origin) continue
      const n = normalize(raw)
      if (!n) continue
      inbound.set(n, (inbound.get(n) ?? 0) + 1)
      const status = opts.knownStatuses?.get(n)
      if (status === 404 || status === 410) {
        brokenInternal.push({ from: fromN, to: n })
      }
    }
  }
  // Sitemap URLs with no inbound edge from inspected pages are possible
  // orphans. The root itself is never an orphan.
  const possibleOrphans: string[] = []
  const rootN = normalize(input.origin + "/")
  for (const s of input.sitemapUrls) {
    const n = normalize(s)
    if (!n || known.has(n)) continue
    if (n === rootN) continue
    if ((inbound.get(n) ?? 0) === 0) possibleOrphans.push(s)
  }
  return { brokenInternal, possibleOrphans, knownUrls: known }
}
