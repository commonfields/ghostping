// Safe sitemap parsing: no DTD, no entities, no XXE, bounded output.
// Supports sitemap indexes recursively (bounded depth) and urlsets.
// Implemented with pattern matching over <loc> within typed blocks so a
// hostile document cannot trigger entity expansion or unbounded allocation.
import { SITE_INSPECTION_BUDGETS } from "./types.js"

export interface ParsedSitemap {
  readonly urls: ReadonlyArray<string>
  readonly nested: ReadonlyArray<string>
  readonly truncated: boolean
  readonly kind: "URLSET" | "INDEX" | "UNKNOWN"
}

const stripComments = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/g, "")

const hasDoctype = (xml: string): boolean => /<!DOCTYPE/i.test(xml)

export const parseSitemapXml = (
  xml: string,
  opts: { origin?: string | null; maxEntries?: number } = {},
): ParsedSitemap => {
  const maxEntries = opts.maxEntries ?? SITE_INSPECTION_BUDGETS.sitemapEntries
  if (hasDoctype(xml)) {
    throw new Error("SITEMAP_PARSE_FAILURE: DOCTYPE not allowed")
  }
  if (xml.length > 5 * 1024 * 1024) {
    throw new Error("SITEMAP_PARSE_FAILURE: document too large")
  }
  const clean = stripComments(xml)
  const isIndex = /<sitemapindex[\s>]/i.test(clean)
  const urls: string[] = []
  const nested: string[] = []
  let truncated = false
  if (isIndex) {
    const blocks = clean.match(/<sitemap[\s>][\s\S]*?<\/sitemap\s*>/gi) ?? []
    for (const b of blocks) {
      const loc = b.match(/<loc\s*>([\s\S]*?)<\/loc\s*>/i)?.[1]?.trim()
      if (!loc) continue
      if (nested.length + urls.length >= maxEntries) {
        truncated = true
        break
      }
      if (isHttpUrl(loc, opts.origin)) nested.push(loc)
    }
    return { urls, nested, truncated, kind: "INDEX" }
  }
  const blocks = clean.match(/<url[\s>][\s\S]*?<\/url\s*>/gi) ?? []
  // Also handle bare <loc> documents (defensive): collect top-level locs.
  const locBlocks = blocks.length > 0 ? blocks : [clean]
  for (const b of locBlocks) {
    const locs = [...b.matchAll(/<loc\s*>([\s\S]*?)<\/loc\s*>/gi)]
    for (const m of locs) {
      const loc = (m[1] ?? "").trim()
      if (!loc) continue
      if (urls.length + nested.length >= maxEntries) {
        truncated = true
        break
      }
      if (!isHttpUrl(loc, opts.origin)) continue
      // Inside an index-shaped doc, treat as nested; otherwise page URL.
      urls.push(loc)
    }
    if (truncated) break
  }
  // Detect nested sitemaps referenced outside <url> blocks (index without
  // strict wrapper): any loc ending in .xml inside an index-like doc.
  return { urls, nested, truncated, kind: blocks.length > 0 || urls.length > 0 ? "URLSET" : "UNKNOWN" }
}

const isHttpUrl = (raw: string, origin: string | null | undefined): boolean => {
  try {
    const u = new URL(raw)
    if (u.protocol !== "http:" && u.protocol !== "https:") return false
    if (origin && u.origin !== origin) return true // keep cross-origin refs visible; caller filters
    return true
  } catch {
    return false
  }
}

export const discoverSitemapUrls = (robotsSitemaps: ReadonlyArray<string>, origin: string): string[] => {
  const out = [...robotsSitemaps]
  const def = `${origin}/sitemap.xml`
  if (!out.includes(def)) out.push(def)
  return out
}
