import { describe, expect, it } from "vitest"
import {
  effectiveCrawlDelayMs,
  fetchAndParseRobots,
  isAllowed,
  isCrawlForbidden,
  parseRobots,
  type SafeHttpFetcher,
} from "../src/robots.js"
import { DISCOVERY_BUDGETS_V1 } from "../src/types.js"

const fetcherFor = (status: number, body = ""): SafeHttpFetcher => ({
  fetch: async () => ({ status, headers: { "content-type": "text/plain" }, body: Buffer.from(body), finalUrl: "" }),
})

const fetcherForFinalUrl = (status: number, body: string, finalUrl: string): SafeHttpFetcher => ({
  fetch: async () => ({ status, headers: { "content-type": "text/plain" }, body: Buffer.from(body), finalUrl }),
})

describe("parseRobots", () => {
  it("applies matching group disallows and ignores others", () => {
    const rules = parseRobots(
      "User-agent: OpenRecordDiscovery\nDisallow: /private\n\nUser-agent: OtherBot\nDisallow: /public\n",
    )
    expect(rules.disallows).toEqual(["/private"])
    expect(isAllowed("/private/x", rules)).toBe(false)
    expect(isAllowed("/public", rules)).toBe(true)
  })

  it("star group applies to us; empty disallow allows all", () => {
    const rules = parseRobots("User-agent: *\nDisallow:\n")
    expect(rules.disallows).toEqual([])
    expect(isAllowed("/anything", rules)).toBe(true)
  })

  it("collects sitemap directives including cross-origin", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /x\nSitemap: https://cdn.example/s.xml\nSitemap: https://a.example/s.xml\n")
    expect(rules.sitemaps).toEqual(["https://a.example/s.xml", "https://cdn.example/s.xml"])
  })

  it("parses crawl-delay seconds to ms", () => {
    const rules = parseRobots("User-agent: *\nCrawl-delay: 2\n")
    expect(rules.crawlDelayMs).toBe(2000)
    expect(effectiveCrawlDelayMs(rules)).toBe(2000)
  })

  it("falls back to the 200ms floor without crawl-delay", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /x\n")
    expect(effectiveCrawlDelayMs(rules)).toBe(DISCOVERY_BUDGETS_V1.crawlDelayMs)
  })

  it("specific-group-overrides-wildcard (no union with *)", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /star\n\nUser-agent: OpenRecordDiscovery\nDisallow: /specific\n",
    )
    expect(rules.disallows).toEqual(["/specific"])
    expect(isAllowed("/specific/x", rules)).toBe(false)
    expect(isAllowed("/star", rules)).toBe(true)
  })

  it("most-specific applicable group wins among specifics", () => {
    const rules = parseRobots(
      "User-agent: openrecord\nDisallow: /general\n\nUser-agent: openrecorddiscovery\nDisallow: /exact\n",
    )
    expect(rules.disallows).toEqual(["/exact"])
    expect(isAllowed("/exact/x", rules)).toBe(false)
    expect(isAllowed("/general", rules)).toBe(true)
  })

  it("wildcard-fallback when no specific group exists", () => {
    const rules = parseRobots(
      "User-agent: OtherBot\nDisallow: /other\n\nUser-agent: *\nDisallow: /wild\n",
    )
    expect(rules.disallows).toEqual(["/wild"])
    expect(isAllowed("/wild/x", rules)).toBe(false)
    expect(isAllowed("/other", rules)).toBe(true)
  })

  it("Disallow / denies all", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /\n")
    expect(isAllowed("/", rules)).toBe(false)
    expect(isAllowed("/anything", rules)).toBe(false)
    expect(isAllowed("/private/public/", rules)).toBe(false)
  })

  it("empty Disallow allows all", () => {
    const rules = parseRobots("User-agent: *\nDisallow:\n")
    expect(rules.disallows).toEqual([])
    expect(isAllowed("/", rules)).toBe(true)
    expect(isAllowed("/anything", rules)).toBe(true)
  })

  it("Allow-exception for a subpath", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private/\nAllow: /private/public/\n")
    expect(isAllowed("/private/public/file", rules)).toBe(true)
    expect(isAllowed("/private/public/", rules)).toBe(true)
    expect(isAllowed("/private/other", rules)).toBe(false)
  })

  it("wildcard * matches any sequence", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private/*\n")
    expect(isAllowed("/private/x", rules)).toBe(false)
    expect(isAllowed("/private/", rules)).toBe(false)
    expect(isAllowed("/other", rules)).toBe(true)
  })

  it("end-anchor $ requires exact end", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\n")
    expect(isAllowed("/a.pdf", rules)).toBe(false)
    expect(isAllowed("/dir/b.pdf", rules)).toBe(false)
    expect(isAllowed("/a.pdfx", rules)).toBe(true)
    expect(isAllowed("/a.pdf/next", rules)).toBe(true)
  })

  it("longest-match-wins", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /foo\nAllow: /foo/bar\n")
    expect(isAllowed("/foo/bar/baz", rules)).toBe(true)
    expect(isAllowed("/foo/other", rules)).toBe(false)
  })

  it("Allow-wins-ties", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /foo\nAllow: /foo\n")
    expect(isAllowed("/foo/bar", rules)).toBe(true)
    expect(isAllowed("/foo", rules)).toBe(true)
  })

  it("unknown syntax is non-matching (conservative)", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /ok\nAllow: ???\nDisallow: /mid$dle\n")
    expect(isAllowed("/ok/x", rules)).toBe(false)
    expect(isAllowed("/other", rules)).toBe(true)
  })

  it("crawl-delay-from-selected-group only (ignores wildcard when specific exists)", () => {
    const both = parseRobots(
      "User-agent: *\nCrawl-delay: 5\n\nUser-agent: OpenRecordDiscovery\nCrawl-delay: 1\n",
    )
    expect(both.crawlDelayMs).toBe(1000)

    const fallback = parseRobots("User-agent: *\nCrawl-delay: 5\n")
    expect(fallback.crawlDelayMs).toBe(5000)

    const specificWithoutDelay = parseRobots(
      "User-agent: *\nCrawl-delay: 5\n\nUser-agent: OpenRecordDiscovery\nDisallow: /x\n",
    )
    expect(specificWithoutDelay.crawlDelayMs).toBeNull()
    expect(effectiveCrawlDelayMs(specificWithoutDelay)).toBe(DISCOVERY_BUDGETS_V1.crawlDelayMs)
  })
})

describe("fetchAndParseRobots", () => {
  it("404 and 410 mean no file (crawl allowed)", async () => {
    for (const status of [404, 410]) {
      const out = await fetchAndParseRobots("https://a.example", fetcherFor(status))
      expect(out.state).toBe("NO_FILE")
      expect(isCrawlForbidden(out)).toBe(false)
    }
  })

  it("401/403 mean ROBOTS_DENIED (no crawl)", async () => {
    for (const status of [401, 403]) {
      const out = await fetchAndParseRobots("https://a.example", fetcherFor(status))
      expect(out.state).toBe("DENIED")
      expect(isCrawlForbidden(out)).toBe(true)
    }
  })

  it("5xx and network errors mean ROBOTS_UNAVAILABLE (fail-closed)", async () => {
    const unavailable = await fetchAndParseRobots("https://a.example", fetcherFor(503))
    expect(unavailable.state).toBe("UNAVAILABLE")
    expect(isCrawlForbidden(unavailable)).toBe(true)
    const failing: SafeHttpFetcher = {
      fetch: async () => {
        throw new Error("boom")
      },
    }
    const net = await fetchAndParseRobots("https://a.example", failing)
    expect(net.state).toBe("UNAVAILABLE")
    expect(isCrawlForbidden(net)).toBe(true)
  })

  it("200 parses the body", async () => {
    const out = await fetchAndParseRobots("https://a.example", fetcherFor(200, "User-agent: *\nDisallow: /p\n"))
    expect(out.state).toBe("PARSED")
    if (out.state === "PARSED") expect(isAllowed("/p", out.rules)).toBe(false)
  })

  it("cross-origin-redirect-rejected when allowCrossOrigin is false", async () => {
    const evil = fetcherForFinalUrl(
      200,
      "User-agent: *\nDisallow: /\n",
      "https://evil.example/robots.txt",
    )
    const out = await fetchAndParseRobots("https://a.example", evil, ["OpenRecordDiscovery", "*"], {
      scopeOrigin: "https://a.example",
      allowCrossOrigin: false,
    })
    expect(out.state).toBe("UNAVAILABLE")
    if (out.state === "UNAVAILABLE") expect(out.detail).toBe("OUT_OF_SCOPE_REDIRECT")
    expect(isCrawlForbidden(out)).toBe(true)
  })

  it("same-origin-redirect-allowed when allowCrossOrigin is false", async () => {
    const same = fetcherForFinalUrl(
      200,
      "User-agent: *\nDisallow: /p\n",
      "https://a.example/robots.txt?via=redirect",
    )
    const out = await fetchAndParseRobots("https://a.example", same, ["OpenRecordDiscovery", "*"], {
      scopeOrigin: "https://a.example",
      allowCrossOrigin: false,
    })
    expect(out.state).toBe("PARSED")
    if (out.state === "PARSED") {
      expect(isAllowed("/p", out.rules)).toBe(false)
      expect(isAllowed("/other", out.rules)).toBe(true)
    }
  })

  it("defaults to current behavior (cross-origin allowed) when scope opts omitted", async () => {
    const evil = fetcherForFinalUrl(
      200,
      "User-agent: *\nDisallow: /p\n",
      "https://evil.example/robots.txt",
    )
    const out = await fetchAndParseRobots("https://a.example", evil)
    expect(out.state).toBe("PARSED")
  })
})
