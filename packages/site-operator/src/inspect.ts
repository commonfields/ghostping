// Pure HTML inspection: deterministic, no network, no LLM.
// Parses static HTML with cheerio and derives concrete findings with
// captured evidence. Never emits scores.
import { load } from "cheerio"
import { createHash } from "node:crypto"
import {
  FINDING_KIND_META,
  type ClassifiedPage,
  type DerivedFinding,
  type FindingKind,
  type Indexability,
  type PageEvidence,
} from "./types.js"

export interface RawPageInput {
  readonly url: string
  readonly finalUrl: string
  readonly status: number | null
  readonly contentType: string | null
  readonly redirectChain: ReadonlyArray<string>
  readonly headers: Record<string, string>
  readonly html: string | null
  readonly failure: string | null
  readonly robotsDisallowed?: boolean
}

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex")

const lowerHeaders = (headers: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
  return out
}

const hasNoindexDirective = (value: string | null): boolean => {
  if (!value) return false
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes("noindex")
}

const hasNofollowDirective = (value: string | null): boolean => {
  if (!value) return false
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes("nofollow")
}

export const extractPageEvidence = (input: RawPageInput): PageEvidence => {
  const headers = lowerHeaders(input.headers)
  const xRobots = headers["x-robots-tag"] ?? null
  if (input.html === null || input.status === null || input.status < 200 || input.status >= 300) {
    return {
      url: input.url,
      finalUrl: input.finalUrl,
      status: input.status,
      contentType: input.contentType,
      redirectChain: input.redirectChain,
      headers,
      robotsMeta: null,
      xRobotsTag: xRobots,
      canonical: null,
      title: null,
      metaDescription: null,
      h1Present: false,
      h1Count: 0,
      internalLinks: [],
      brokenInternalLinks: [],
      imagesMissingAlt: 0,
      imagesTotal: 0,
      jsonLdBlocks: [],
      bodyDigest: input.html === null ? null : sha256Hex(input.html),
      bodyBytes: input.html === null ? 0 : Buffer.byteLength(input.html, "utf8"),
      failure: input.failure,
    }
  }
  const html = input.html
  let robotsMeta: string | null = null
  let canonical: string | null = null
  let title: string | null = null
  let metaDescription: string | null = null
  let h1Count = 0
  let imagesTotal = 0
  let imagesMissingAlt = 0
  const internalLinks: string[] = []
  const jsonLdBlocks: Array<{ raw: string; valid: boolean; error: string | null }> = []
  try {
    const $ = load(html)
    const robotsEl = $('meta[name="robots" i]').first()
    if (robotsEl.length > 0) robotsMeta = robotsEl.attr("content") ?? null
    const canonicalEl = $('link[rel="canonical" i]').first()
    if (canonicalEl.length > 0) canonical = (canonicalEl.attr("href") ?? "").trim() || null
    const titleEl = $("title").first()
    if (titleEl.length > 0) {
      const t = titleEl.text().trim()
      title = t.length > 0 ? t : null
    }
    const descEl = $('meta[name="description" i]').first()
    if (descEl.length > 0) {
      const d = (descEl.attr("content") ?? "").trim()
      metaDescription = d.length > 0 ? d : null
    }
    h1Count = $("h1").length
    $("img").each((_i, el) => {
      imagesTotal += 1
      const alt = $(el).attr("alt")
      if (alt === undefined || alt.trim() === "") imagesMissingAlt += 1
    })
    const seen = new Set<string>()
    $("a[href]").each((_i, el) => {
      const href = ($(el).attr("href") ?? "").trim()
      if (href === "" || href.startsWith("#")) return
      if (/^(mailto|tel|javascript|data):/i.test(href)) return
      try {
        const resolved = new URL(href, input.finalUrl).toString()
        if (!seen.has(resolved)) {
          seen.add(resolved)
          internalLinks.push(resolved)
        }
      } catch {
        // ignore unresolvable
      }
    })
    $('script[type="application/ld+json"]').each((_i, el) => {
      const raw = $(el).text()
      if (raw.trim() === "") return
      try {
        JSON.parse(raw)
        jsonLdBlocks.push({ raw: raw.slice(0, 2000), valid: true, error: null })
      } catch (e) {
        jsonLdBlocks.push({
          raw: raw.slice(0, 2000),
          valid: false,
          error: e instanceof Error ? e.message.slice(0, 300) : "parse error",
        })
      }
    })
  } catch {
    // cheerio failure: evidence records what headers/status showed; the
    // caller classifies RENDERING_FAILURE via failure field if needed.
  }
  return {
    url: input.url,
    finalUrl: input.finalUrl,
    status: input.status,
    contentType: input.contentType,
    redirectChain: input.redirectChain,
    headers,
    robotsMeta,
    xRobotsTag: xRobots,
    canonical: canonical ? resolveUrl(canonical, input.finalUrl) : null,
    title,
    metaDescription,
    h1Present: h1Count > 0,
    h1Count,
    internalLinks,
    brokenInternalLinks: [],
    imagesMissingAlt,
    imagesTotal,
    jsonLdBlocks,
    bodyDigest: sha256Hex(html),
    bodyBytes: Buffer.byteLength(html, "utf8"),
    failure: input.failure,
  }
}

const resolveUrl = (href: string, base: string): string | null => {
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}

const finding = (
  kind: FindingKind,
  url: string,
  evidence: Record<string, unknown>,
  diagnosis: string,
  recommendedAction: string,
  confidence: DerivedFinding["confidence"],
): DerivedFinding => {
  const meta = FINDING_KIND_META[kind]
  return {
    findingKind: kind,
    severity: meta.severity,
    category: meta.category,
    url,
    evidence,
    diagnosis,
    recommendedAction,
    confidence,
  }
}

export const classifyIndexability = (ev: PageEvidence, robotsDisallowed: boolean): Indexability => {
  if (ev.failure === "REDIRECT_LIMIT") return "UNKNOWN"
  if (ev.status === null) return "UNKNOWN"
  if (ev.status === 404) return "NOT_FOUND"
  if (ev.status >= 500) return "SERVER_ERROR"
  if (ev.redirectChain.length > 1 && ev.url !== ev.finalUrl) {
    // Redirected: terminal classification depends on landing state, but a
    // pure redirect observation (3xx with no body) is REDIRECTED.
    if (ev.status >= 300 && ev.status < 400) return "REDIRECTED"
  }
  if (hasNoindexDirective(ev.robotsMeta)) return "BLOCKED_BY_META"
  if (hasNoindexDirective(ev.xRobotsTag)) return "BLOCKED_BY_HEADER"
  if (robotsDisallowed) return "BLOCKED_BY_ROBOTS"
  if (ev.canonical) {
    try {
      const canon = new URL(ev.canonical)
      const fin = new URL(ev.finalUrl)
      canon.hash = ""
      fin.hash = ""
      if (canon.toString() !== fin.toString()) return "CANONICALIZED_ELSEWHERE"
    } catch {
      // malformed canonical handled as a finding, not here
    }
  }
  if (ev.status >= 200 && ev.status < 300) return "INDEXABLE"
  return "UNKNOWN"
}

/** Derive deterministic findings from one page observation. */
export const derivePageFindings = (
  ev: PageEvidence,
  opts: { robotsDisallowed: boolean; knownUrls?: Set<string> | undefined },
): DerivedFinding[] => {
  const out: DerivedFinding[] = []
  const url = ev.finalUrl

  if (ev.failure === "REDIRECT_LIMIT" || (ev.redirectChain.length > 5 && ev.status !== null && ev.status >= 300)) {
    out.push(
      finding(
        "REDIRECT_LOOP",
        url,
        { redirectChain: ev.redirectChain },
        "The URL ends in a redirect loop or exceeds the redirect limit, so crawlers cannot reach a document.",
        "Break the redirect cycle so the URL resolves to a single final document.",
        "HIGH",
      ),
    )
    return out
  }
  if (ev.redirectChain.length > 3) {
    out.push(
      finding(
        "REDIRECT_CHAIN_LONG",
        url,
        { redirectChain: ev.redirectChain, hops: ev.redirectChain.length - 1 },
        `The URL passes through ${ev.redirectChain.length - 1} redirects before reaching the final document.`,
        "Shorten the redirect chain to a single hop where possible.",
        "MEDIUM",
      ),
    )
  }
  if (ev.status === 404) {
    out.push(
      finding(
        "NOT_FOUND",
        url,
        { status: ev.status, finalUrl: ev.finalUrl },
        "The URL returns 404, so it cannot be indexed or serve customers.",
        "Restore the page, or redirect it to the closest live replacement and update internal links.",
        "HIGH",
      ),
    )
    return out
  }
  if (ev.status !== null && ev.status >= 500) {
    out.push(
      finding(
        "SERVER_ERROR",
        url,
        { status: ev.status, finalUrl: ev.finalUrl },
        `The server returns ${ev.status} for this URL, so the page cannot be indexed.`,
        "Fix the server error so the URL returns a successful document.",
        "HIGH",
      ),
    )
    return out
  }
  if (ev.status !== null && (ev.status < 200 || ev.status >= 300)) return out

  if (hasNoindexDirective(ev.robotsMeta)) {
    out.push(
      finding(
        "BLOCKED_BY_META",
        url,
        { robotsMeta: ev.robotsMeta },
        "Search engines are explicitly instructed not to index this page.",
        "Remove `noindex` from the production document head.",
        "HIGH",
      ),
    )
  }
  if (hasNoindexDirective(ev.xRobotsTag)) {
    out.push(
      finding(
        "BLOCKED_BY_HEADER",
        url,
        { xRobotsTag: ev.xRobotsTag },
        "The server sends an X-Robots-Tag header instructing search engines not to index this page.",
        "Remove `noindex` from the X-Robots-Tag response header for this URL.",
        "HIGH",
      ),
    )
  }
  if (opts.robotsDisallowed) {
    out.push(
      finding(
        "BLOCKED_BY_ROBOTS",
        url,
        { robotsDisallowed: true, url: ev.finalUrl },
        "robots.txt disallows crawling of this URL, so search engines cannot fetch it.",
        "Allow the URL in robots.txt if it should be discoverable.",
        "HIGH",
      ),
    )
  }
  if (ev.canonical) {
    let broken = false
    try {
      const u = new URL(ev.canonical, ev.finalUrl)
      if (u.protocol !== "http:" && u.protocol !== "https:") broken = true
    } catch {
      broken = true
    }
    if (broken) {
      out.push(
        finding(
          "BROKEN_CANONICAL",
          url,
          { canonical: ev.canonical },
          `The canonical tag points to an invalid URL (${ev.canonical}).`,
          "Point the canonical tag at the correct absolute URL of this page.",
          "HIGH",
        ),
      )
    } else {
      try {
        const canon = new URL(ev.canonical)
        const fin = new URL(ev.finalUrl)
        canon.hash = ""
        fin.hash = ""
        if (canon.toString() !== fin.toString()) {
          out.push(
            finding(
              "CANONICALIZED_ELSEWHERE",
              url,
              { canonical: ev.canonical, finalUrl: ev.finalUrl },
              `The canonical tag points to ${ev.canonical} instead of this page, so search engines consolidate indexing signals elsewhere.`,
              "Point the canonical tag at this page, or remove it if consolidation elsewhere is unintentional.",
              "HIGH",
            ),
          )
        }
      } catch {
        // already handled
      }
    }
  }
  if (!ev.title) {
    out.push(
      finding(
        "MISSING_TITLE",
        url,
        { title: null },
        "The page has no title element, so search results cannot show a page-specific title.",
        "Add a concise, descriptive title element.",
        "MEDIUM",
      ),
    )
  }
  void hasNofollowDirective
  if (!ev.metaDescription) {
    out.push(
      finding(
        "MISSING_DESCRIPTION",
        url,
        { metaDescription: null },
        "The page has no meta description, so search results fall back to extracted text.",
        "Add a concise meta description summarizing the page.",
        "LOW",
      ),
    )
  }
  if (!ev.h1Present) {
    out.push(
      finding(
        "MISSING_H1",
        url,
        { h1Count: ev.h1Count },
        "The page has no primary heading (h1), so its topic structure is weaker.",
        "Add one descriptive h1 to the page.",
        "LOW",
      ),
    )
  }
  for (const b of ev.jsonLdBlocks) {
    if (!b.valid) {
      out.push(
        finding(
          "INVALID_STRUCTURED_DATA",
          url,
          { error: b.error, snippet: b.raw.slice(0, 500) },
          "A structured-data block on the page cannot be parsed, so search engines ignore it.",
          "Fix the JSON-LD syntax so the block parses.",
          "MEDIUM",
        ),
      )
      break
    }
  }
  if (ev.imagesTotal > 0 && ev.imagesMissingAlt > 0) {
    out.push(
      finding(
        "MISSING_ALT",
        url,
        { imagesMissingAlt: ev.imagesMissingAlt, imagesTotal: ev.imagesTotal },
        `${ev.imagesMissingAlt} of ${ev.imagesTotal} images have no usable alternative text.`,
        "Add descriptive alt text to informative images.",
        "LOW",
      ),
    )
  }
  return out
}

/** Rendered-vs-source discrepancy: material difference between static HTML
 * and browser-rendered output (e.g. JS-injected noindex or content).
 * Returns true when the rendered document changes indexability-relevant
 * signals. The crawler should select rendered inspection when true. */
export const hasRenderDiscrepancy = (sourceHtml: string, renderedHtml: string): boolean => {
  const src = extractPageEvidence({
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    contentType: "text/html",
    redirectChain: ["https://example.com/"],
    headers: {},
    html: sourceHtml,
    failure: null,
  })
  const rendered = extractPageEvidence({
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    contentType: "text/html",
    redirectChain: ["https://example.com/"],
    headers: {},
    html: renderedHtml,
    failure: null,
  })
  if (src.robotsMeta !== rendered.robotsMeta) return true
  if (src.canonical !== rendered.canonical) return true
  if ((src.title ?? "") !== (rendered.title ?? "")) return true
  return false
}

/** Full page classification: evidence + indexability + findings. */
export const inspectPage = (
  input: RawPageInput,
  opts: { knownUrls?: Set<string> | undefined } = {},
): ClassifiedPage => {
  const ev = extractPageEvidence(input)
  const robotsDisallowed = input.robotsDisallowed ?? false
  const indexability = classifyIndexability(ev, robotsDisallowed)
  const findings = derivePageFindings(ev, { robotsDisallowed, knownUrls: opts.knownUrls })
  return { evidence: ev, indexability, findings }
}
