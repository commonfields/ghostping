// SEARCH_OPERATOR_V1 deterministic fixtures A-J + contract tests.
// No network, no randomness: pure inspection logic over static HTML.
import { describe, expect, it } from "vitest"
import { isForbiddenIp } from "@openrecord/representation"
import {
  FINDING_KIND_META,
  canTransitionFinding,
  canTransitionRun,
} from "../src/types.js"
import { extractPageEvidence, classifyIndexability, derivePageFindings, hasRenderDiscrepancy } from "../src/inspect.js"
import { parseRobotsTxt, isUrlAllowedByRobots } from "../src/robots.js"
import { parseSitemapXml } from "../src/sitemap.js"
import { buildLinkGraph } from "../src/linkgraph.js"
import { findingIdentityKey } from "../src/identity.js"
import { proposeFix, removeNoindexFromHtml } from "../src/fixes.js"

const healthyHtml = `<!doctype html><html><head><title>Acme Plumbing</title>
<meta name="description" content="Same-day plumbing in Springfield.">
<link rel="canonical" href="https://example.com/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Acme"}</script>
</head><body><h1>Acme Plumbing</h1><a href="/services">Services</a><img src="/van.jpg" alt="Service van"></body></html>`

const ev = (html: string, overrides: Record<string, unknown> = {}) => ({
  url: "https://example.com/",
  finalUrl: "https://example.com/",
  status: 200,
  contentType: "text/html",
  redirectChain: ["https://example.com/"],
  headers: {},
  html,
  failure: null,
  ...overrides,
})

describe("fixture A — healthy", () => {
  it("produces no critical/high findings and is indexable", () => {
    const page = extractPageEvidence(ev(healthyHtml))
    expect(classifyIndexability(page, false)).toBe("INDEXABLE")
    const findings = derivePageFindings(page, { robotsDisallowed: false })
    expect(findings.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH")).toEqual([])
  })
})

describe("fixture B — accidental noindex", () => {
  it("classifies BLOCKED_BY_META with exact evidence", () => {
    const html = healthyHtml.replace("</head>", '<meta name="robots" content="noindex">\n</head>')
    const page = extractPageEvidence(ev(html))
    expect(classifyIndexability(page, false)).toBe("BLOCKED_BY_META")
    const findings = derivePageFindings(page, { robotsDisallowed: false })
    const blocked = findings.find((f) => f.findingKind === "BLOCKED_BY_META")
    expect(blocked).toBeDefined()
    expect(blocked?.evidence).toMatchObject({ robotsMeta: expect.stringContaining("noindex") })
    expect(blocked?.confidence).toBe("HIGH")
    // Fix proposal requires approval and shows before/after
    const fix = proposeFix(blocked!)
    expect(fix?.classification).toBe("APPROVAL_REQUIRED")
    expect(fix?.requiresApproval).toBe(true)
    expect(removeNoindexFromHtml(html)).not.toContain("noindex")
  })
})

describe("fixture C — robots block", () => {
  it("marks the URL disallowed and derives BLOCKED_BY_ROBOTS", () => {
    const rules = parseRobotsTxt("User-agent: *\nDisallow: /\n")
    expect(isUrlAllowedByRobots("https://example.com/services", rules)).toBe(false)
    const page = extractPageEvidence(ev(healthyHtml))
    expect(classifyIndexability(page, true)).toBe("BLOCKED_BY_ROBOTS")
    const findings = derivePageFindings(page, { robotsDisallowed: true })
    expect(findings.some((f) => f.findingKind === "BLOCKED_BY_ROBOTS")).toBe(true)
  })
})

describe("fixture D — broken canonical", () => {
  it("classifies CANONICALIZED_ELSEWHERE when canonical points to the homepage", () => {
    const html = `<!doctype html><html><head><title>Plumbing Services</title><link rel="canonical" href="https://example.com/"></head><body><h1>Services</h1></body></html>`
    const page = extractPageEvidence(
      ev(html, { url: "https://example.com/services", finalUrl: "https://example.com/services", redirectChain: ["https://example.com/services"] }),
    )
    expect(classifyIndexability(page, false)).toBe("CANONICALIZED_ELSEWHERE")
    const findings = derivePageFindings(page, { robotsDisallowed: false })
    expect(findings.some((f) => f.findingKind === "CANONICALIZED_ELSEWHERE")).toBe(true)
    expect(FINDING_KIND_META.CANONICALIZED_ELSEWHERE.severity).toBe("HIGH")
  })
})

describe("fixture E — redirect loop", () => {
  it("derives a redirect finding instead of success", () => {
    const page = extractPageEvidence({
      url: "https://example.com/a",
      finalUrl: "https://example.com/a",
      status: null,
      contentType: null,
      redirectChain: ["https://example.com/a", "https://example.com/b", "https://example.com/a"],
      headers: {},
      html: null,
      failure: "REDIRECT_LIMIT",
    })
    const findings = derivePageFindings(page, { robotsDisallowed: false })
    expect(findings.some((f) => f.findingKind === "REDIRECT_LOOP")).toBe(true)
  })
})

describe("fixture F — broken internal link", () => {
  it("detects the broken edge in the link graph", () => {
    const statuses = new Map<string, number | null>([["https://example.com/gone", 404]])
    const graph = buildLinkGraph(
      { pages: [{ url: "https://example.com/", links: ["https://example.com/gone", "https://example.com/services"] }], sitemapUrls: [], origin: "https://example.com" },
      { knownStatuses: statuses },
    )
    expect(graph.brokenInternal).toEqual([{ from: "https://example.com/", to: "https://example.com/gone" }])
  })
})

describe("fixture G — sitemap orphan", () => {
  it("labels sitemap-only URLs POSSIBLE_ORPHAN, never ORPHAN", () => {
    const graph = buildLinkGraph(
      { pages: [{ url: "https://example.com/", links: ["https://example.com/services"] }], sitemapUrls: ["https://example.com/", "https://example.com/hidden"], origin: "https://example.com" },
      {},
    )
    expect(graph.possibleOrphans).toEqual(["https://example.com/hidden"])
  })
})

describe("fixture H — malformed structured data", () => {
  it("derives INVALID_STRUCTURED_DATA with parse evidence", () => {
    const html = `<!doctype html><html><head><title>T</title><script type="application/ld+json">{"@type": broken</script></head><body><h1>T</h1></body></html>`
    const page = extractPageEvidence(ev(html))
    expect(page.jsonLdBlocks.some((b) => !b.valid)).toBe(true)
    expect(derivePageFindings(page, { robotsDisallowed: false }).some((f) => f.findingKind === "INVALID_STRUCTURED_DATA")).toBe(true)
  })
})

describe("fixture I — JS-rendered discrepancy", () => {
  it("selects rendered inspection when signals differ", () => {
    const source = `<!doctype html><html><head><title>T</title></head><body><h1>T</h1></body></html>`
    const rendered = `<!doctype html><html><head><title>T</title><meta name="robots" content="noindex"></head><body><h1>T</h1></body></html>`
    expect(hasRenderDiscrepancy(source, rendered)).toBe(true)
    expect(hasRenderDiscrepancy(source, source)).toBe(false)
  })
})

describe("fixture J — SSRF attempts fail closed", () => {
  it("rejects loopback, private, link-local, and metadata targets", () => {
    for (const ip of ["127.0.0.1", "127.0.0.5", "10.1.2.3", "172.16.9.9", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "100.100.100.200"]) {
      expect(isForbiddenIp(ip), ip).toBe(true)
    }
    expect(isForbiddenIp("93.184.216.34")).toBe(false)
  })
})

describe("sitemap discovery", () => {
  it("parses indexes and urlsets without entity expansion", () => {
    const index = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/services-sitemap.xml</loc></sitemap></sitemapindex>`
    const parsed = parseSitemapXml(index, { origin: "https://example.com" })
    expect(parsed.kind).toBe("INDEX")
    expect(parsed.nested).toContain("https://example.com/services-sitemap.xml")
    expect(() => parseSitemapXml(`<!DOCTYPE foo [<!ENTITY x "y">]><urlset><url><loc>https://example.com/</loc></url></urlset>`)).toThrow()
    const urlset = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>`
    expect(parseSitemapXml(urlset).urls).toContain("https://example.com/")
  })
})

describe("finding identity + lifecycle contracts", () => {
  it("repeated identical inspections share one identity key", () => {
    const evidence = { robotsMeta: "noindex" }
    const a = findingIdentityKey({ businessId: "b1", url: "https://example.com/#frag", findingKind: "BLOCKED_BY_META", evidence })
    const b = findingIdentityKey({ businessId: "b1", url: "https://example.com/", findingKind: "BLOCKED_BY_META", evidence })
    expect(a).toBe(b)
    const c = findingIdentityKey({ businessId: "b1", url: "https://example.com/", findingKind: "BLOCKED_BY_HEADER", evidence })
    expect(c).not.toBe(a)
  })

  it("finding transitions preserve history (no silent success)", () => {
    expect(canTransitionFinding("OPEN", "VERIFIED_FIXED")).toBe(false)
    expect(canTransitionFinding("OPEN", "AWAITING_APPROVAL")).toBe(true)
    expect(canTransitionFinding("FIX_APPLIED", "VERIFICATION_PENDING")).toBe(true)
    expect(canTransitionFinding("VERIFICATION_PENDING", "VERIFIED_FIXED")).toBe(true)
    expect(canTransitionFinding("VERIFIED_FIXED", "OPEN")).toBe(true) // regression reopens
  })

  it("run lifecycle never rewrites terminal states", () => {
    expect(canTransitionRun("QUEUED", "RUNNING")).toBe(true)
    expect(canTransitionRun("RUNNING", "SUCCEEDED")).toBe(true)
    expect(canTransitionRun("RUNNING", "PARTIALLY_SUCCEEDED")).toBe(true)
    expect(canTransitionRun("SUCCEEDED", "RUNNING")).toBe(false)
    expect(canTransitionRun("FAILED", "QUEUED")).toBe(false)
  })

  it("title and description fixes require approval (no autonomous copy)", () => {
    const missing = derivePageFindings(extractPageEvidence(ev(`<!doctype html><html><head></head><body><h1>T</h1></body></html>`)), { robotsDisallowed: false })
    const titleFinding = missing.find((f) => f.findingKind === "MISSING_TITLE")!
    expect(proposeFix(titleFinding)?.classification).toBe("MANUAL_ONLY")
  })
})
