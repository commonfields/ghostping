// Sitemap handling V1: safe XML parsing with no external entities, DTD
// entity/system rejection, urlset + sitemapindex support, gzip with
// compressed+decompressed caps, cross-origin sitemaps noted-not-fetched.

import { gunzipSync } from "node:zlib"
import { DISCOVERY_BUDGETS_V1 } from "./types.js"

export class SitemapUnsafe extends Error {
  constructor(detail = "external entity/DTD") {
    super(`SitemapUnsafe: ${detail}`)
    this.name = "SitemapUnsafe"
  }
}

export interface ParsedSitemap {
  readonly urls: ReadonlyArray<string>
  readonly nested: ReadonlyArray<string>
  readonly truncated: boolean
  /** Nested sitemap URLs on another origin: recorded, never fetched. */
  readonly notedNotFetched: ReadonlyArray<string>
}

const ENTITY_RE = /<!ENTITY/i
const DOCTYPE_RE = /<!DOCTYPE\b([\s\S]*?)>/i

/** Reject external entities and DTDs that can carry them. No DTD is ever processed. */
export const assertSafeXml = (xml: string): void => {
  if (ENTITY_RE.test(xml)) throw new SitemapUnsafe("<!ENTITY rejected")
  const doctype = xml.match(DOCTYPE_RE)
  if (doctype !== null) {
    const body = doctype[1] ?? ""
    if (/ENTITY/i.test(body) || /SYSTEM/i.test(body)) {
      throw new SitemapUnsafe("<!DOCTYPE with ENTITY/SYSTEM rejected")
    }
  }
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")

const LOC_RE = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/g
const URL_BLOCK_RE = /<url\b[^>]*>([\s\S]*?)<\/url\s*>/gi
const SITEMAP_BLOCK_RE = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap\s*>/gi

const locsIn = (block: string): string[] => {
  const out: string[] = []
  LOC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LOC_RE.exec(block)) !== null) {
    const v = decodeEntities((m[1] ?? "").trim())
    if (v !== "") out.push(v)
  }
  return out
}

const blocksOf = (xml: string, re: RegExp): string[] => {
  const out: string[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? "")
  return out
}

const isHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

const sameOrigin = (a: string, origin: string): boolean => {
  try {
    return new URL(a).origin === new URL(origin).origin
  } catch {
    return false
  }
}

/**
 * Parse one sitemap document. Supports <urlset> and <sitemapindex>
 * (nested sitemaps may recurse up to the doc budget at collection time).
 * Caps entries at sitemapEntries; sets truncated when cut.
 */
export const parseSitemapXml = (
  xml: string,
  opts: { readonly origin?: string | undefined } = {},
): ParsedSitemap => {
  assertSafeXml(xml)
  const cap = DISCOVERY_BUDGETS_V1.sitemapEntries
  const urls: string[] = []
  const nested: string[] = []

  for (const b of blocksOf(xml, URL_BLOCK_RE)) {
    for (const loc of locsIn(b)) {
      if (isHttpUrl(loc)) urls.push(loc)
    }
  }
  for (const b of blocksOf(xml, SITEMAP_BLOCK_RE)) {
    for (const loc of locsIn(b)) {
      if (isHttpUrl(loc)) nested.push(loc)
    }
  }
  // Tolerant fallback: bare <loc> doc with neither url nor sitemap blocks.
  if (urls.length === 0 && nested.length === 0) {
    LOC_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LOC_RE.exec(xml)) !== null) {
      const v = decodeEntities((m[1] ?? "").trim())
      if (v !== "" && isHttpUrl(v)) urls.push(v)
    }
  }

  const dedupe = (xs: string[]): string[] => [...new Set(xs)]
  let allUrls = dedupe(urls)
  let allNested = dedupe(nested)
  let truncated = false
  if (allUrls.length > cap) {
    allUrls = allUrls.slice(0, cap)
    truncated = true
  }
  if (allNested.length > cap) {
    allNested = allNested.slice(0, cap)
    truncated = true
  }

  let notedNotFetched: string[] = []
  if (opts.origin !== undefined) {
    const local: string[] = []
    for (const n of allNested) {
      if (sameOrigin(n, opts.origin)) local.push(n)
      else notedNotFetched.push(n)
    }
    allNested = local
    notedNotFetched = [...new Set(notedNotFetched)].sort()
  }
  return { urls: allUrls, nested: allNested, truncated, notedNotFetched }
}

export class SitemapGzipError extends Error {
  constructor(detail = "invalid gzip payload") {
    super(`SitemapGzipError: ${detail}`)
    this.name = "SitemapGzipError"
  }
}

const GZIP_MAGIC_0 = 0x1f
const GZIP_MAGIC_1 = 0x8b

/** Magic-byte check: the sole signal for gzip. `.gz` suffix alone never decides. */
export const isGzipBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1

export interface DecodedSitemapBytes {
  readonly xml: string
  readonly truncated: boolean
}

/**
 * CANONICAL V1 gzip path — all sitemap bytes flow through here.
 *
 * Contract (magic bytes win):
 * - Gzip is detected ONLY by magic bytes (0x1f 0x8b) via `isGzipBytes`.
 *   The `url` argument is retained for diagnostics/compat but NEVER
 *   triggers gunzip on its own (`.gz` suffix ignored for the decision).
 * - Magic present -> bounded gunzip enforcing the PER-DOCUMENT cap
 *   `DISCOVERY_BUDGETS_V1.sitemapDecompressedBytes` (5MB) DURING
 *   decompression via `gunzipSync` + `maxOutputLength: cap + 1`.
 *   Allocation never exceeds cap + 1 regardless of bomb size.
 *   Overflow (length > cap, or ERR_BUFFER_TOO_LARGE) is REJECTED as
 *   `{ xml: "", truncated: true }` — never inflate-then-slice.
 * - Magic absent -> treated as plain UTF-8 XML regardless of suffix.
 *   This makes the function idempotent-safe: bytes a caller already
 *   decompressed pass through unchanged (no double-gunzip throw), so the
 *   runner-side pre-`gunzipSync` in apps/worker/src/discovery-runner.ts
 *   (RUNNER OWNER: safe to delete — this function already handles both raw
 *   gzip and pre-decompressed inputs) can be removed without behavior change.
 * - Cap is PER DOCUMENT. This file keeps no cumulative total; any
 *   cross-document budget (e.g. the runner's `decompressedTotal`) lives with
 *   the caller under a separately-named variable, never here.
 * - Invalid gzip (magic present but corrupt) throws `SitemapGzipError`
 *   deterministically — same input always throws the same typed error.
 * - Exact boundary: decompressed length == cap accepted
 *   (`truncated: false`); length == cap + 1 rejected (`truncated: true`).
 *   Plain-XML path enforces the same byte boundary by slicing input bytes
 *   (safe: no inflation involved) and returning the prefix with
 *   `truncated: true`.
 */
export const decodeSitemapBytes = (
  bytes: Uint8Array,
  opts: { readonly url: string },
): DecodedSitemapBytes => {
  const cap = DISCOVERY_BUDGETS_V1.sitemapDecompressedBytes
  // Intentionally unused for the gzip decision (magic wins); kept for API
  // compat and future diagnostics.
  void opts.url
  if (!isGzipBytes(bytes)) {
    if (bytes.length > cap) {
      return { xml: Buffer.from(bytes.slice(0, cap)).toString("utf8"), truncated: true }
    }
    return { xml: Buffer.from(bytes).toString("utf8"), truncated: false }
  }
  let raw: Buffer
  try {
    raw = gunzipSync(bytes, { maxOutputLength: cap + 1 })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
      return { xml: "", truncated: true }
    }
    throw new SitemapGzipError("invalid gzip payload")
  }
  if (raw.length > cap) {
    return { xml: "", truncated: true }
  }
  return { xml: raw.toString("utf8"), truncated: false }
}

/** Decompress (canonical bounded path) under the V1 caps, then parse. */
export const parseSitemapBytes = (
  bytes: Uint8Array,
  opts: { readonly url: string; readonly origin?: string | undefined },
): ParsedSitemap => {
  const { xml, truncated } = decodeSitemapBytes(bytes, { url: opts.url })
  const parsed = parseSitemapXml(xml, { origin: opts.origin })
  return { ...parsed, truncated: parsed.truncated || truncated }
}

export interface SitemapCollector {
  readonly fetchedDocs: number
  readonly urls: ReadonlyArray<string>
  readonly truncated: boolean
  readonly notedNotFetched: ReadonlyArray<string>
}

/**
 * Walk a sitemap tree from entry URLs (robots sitemaps + /sitemap.xml).
 * Cycle-safe via a visited set; stops after sitemapDocs documents and
 * sitemapEntries total URLs. Cross-origin nested sitemaps are recorded,
 * never fetched. Fetch failures skip that document deterministically.
 */
export const collectSitemapUrls = async (
  fetchDoc: (url: string) => Promise<Uint8Array | null>,
  entryUrls: ReadonlyArray<string>,
  origin: string,
): Promise<SitemapCollector> => {
  const maxDocs = DISCOVERY_BUDGETS_V1.sitemapDocs
  const maxEntries = DISCOVERY_BUDGETS_V1.sitemapEntries
  const visited = new Set<string>()
  const queue: string[] = [...new Set(entryUrls)].sort()
  const urls: string[] = []
  const seen = new Set<string>()
  const noted = new Set<string>()
  let fetchedDocs = 0
  let truncated = false

  while (queue.length > 0) {
    if (fetchedDocs >= maxDocs) {
      truncated = true
      break
    }
    const next = queue.shift()!
    if (visited.has(next)) continue
    visited.add(next)
    let bytes: Uint8Array | null
    try {
      bytes = await fetchDoc(next)
    } catch {
      continue
    }
    if (bytes === null) continue
    fetchedDocs += 1
    let parsed: ParsedSitemap
    try {
      parsed = parseSitemapBytes(bytes, { url: next, origin })
    } catch {
      continue
    }
    if (parsed.truncated) truncated = true
    for (const u of parsed.urls) {
      if (seen.has(u)) continue
      seen.add(u)
      if (urls.length >= maxEntries) {
        truncated = true
        break
      }
      urls.push(u)
    }
    for (const n of parsed.notedNotFetched) noted.add(n)
    const pending = parsed.nested.filter((n) => !visited.has(n)).sort()
    for (const n of pending) {
      if (!queue.includes(n)) queue.push(n)
    }
    queue.sort()
  }
  if (queue.length > 0 && fetchedDocs >= maxDocs) truncated = true
  return {
    fetchedDocs,
    urls,
    truncated,
    notedNotFetched: [...noted].sort(),
  }
}
