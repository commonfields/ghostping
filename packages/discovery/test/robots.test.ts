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

describe("parseRobots", () => {
  it("applies matching group disallows and ignores others", () => {
    const rules = parseRobots(
      "User-agent: GhostpingDiscovery\nDisallow: /private\n\nUser-agent: OtherBot\nDisallow: /public\n",
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
})
