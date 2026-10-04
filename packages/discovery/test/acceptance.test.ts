// Acceptance fixture (Acme, no internet): robots -> sitemap -> frontier ->
// matcher -> candidate summaries. Proves the Phase 27 product capability:
// /pricing CURRENT, /docs/billing HISTORICAL, /compare MIXED, robots-
// disallowed never fetched, JS shell yields no candidate (never "absent"),
// off-origin never fetched, LINK query URLs skipped, truth change $59->$69
// reclassifies without claiming $69 absent. No DRIFT/IN_SYNC labels here.

import { createServer, type Server } from "node:http"
import { describe, expect, it } from "vitest"
import { buildFrontier } from "../src/frontier.js"
import { matchPage, summarizeMatches } from "../src/matcher.js"
import { isInScope, validateScope } from "../src/policy.js"
import { isAllowed, parseRobots } from "../src/robots.js"
import { buildAuthoritySnapshot } from "../src/service.js"
import { parseSitemapXml } from "../src/sitemap.js"

const pricingHtml = (price: string) =>
  `<!doctype html><html><head><title>Pricing</title><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    offers: { price, priceCurrency: "USD" },
  })}</script></head><body><h1>Starter $${price}</h1><p>${price} USD per month</p></body></html>`

const billingHtml = (price: string) =>
  `<!doctype html><html><head><meta name="price" content="${price}"><title>Billing</title></head><body><p>Starter costs ${price}.</p></body></html>`

const compareHtml = (oldPrice: string, newPrice: string) =>
  `<!doctype html><html><head><title>Compare</title></head><body><p>Was ${oldPrice}, now ${newPrice}.</p></body></html>`

const shellHtml = () =>
  `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`

const startAcme = async (): Promise<{ base: string; close: () => Promise<void> }> => {
  const routes = new Map<string, { status: number; headers: Record<string, string>; body: string }>()
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/"
    const r = routes.get(path)
    if (!r) {
      res.writeHead(404).end("nope")
      return
    }
    res.writeHead(r.status, r.headers)
    res.end(r.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  const port = typeof addr === "object" && addr !== null ? addr.port : 0
  const base = `http://127.0.0.1:${port}`
  routes.set("/robots.txt", {
    status: 200,
    headers: { "content-type": "text/plain" },
    body: `User-agent: *\nAllow: /\nDisallow: /private/\nSitemap: ${base}/sitemap.xml\n`,
  })
  routes.set("/sitemap.xml", {
    status: 200,
    headers: { "content-type": "application/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      ["pricing", "docs/billing", "compare", "private/old-price", "dynamic"]
        .map((p) => `<url><loc>${base}/${p}</loc></url>`)
        .join("") +
      `</urlset>`,
  })
  routes.set("/pricing", { status: 200, headers: { "content-type": "text/html" }, body: pricingHtml("59") })
  routes.set("/docs/billing", { status: 200, headers: { "content-type": "text/html" }, body: billingHtml("49 USD") })
  routes.set("/compare", { status: 200, headers: { "content-type": "text/html" }, body: compareHtml("49 USD", "59 USD") })
  routes.set("/private/old-price", { status: 200, headers: { "content-type": "text/html" }, body: billingHtml("49 USD") })
  routes.set("/dynamic", { status: 200, headers: { "content-type": "text/html" }, body: shellHtml() })
  routes.set("/", {
    status: 200,
    headers: { "content-type": "text/html" },
    body: `<html><body><a href="/pricing?campaign=x">promo</a><a href="https://other.example/acme">other</a><a href="/dynamic">app</a></body></html>`,
  })
  return {
    base,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

describe("acceptance fixture (Acme, no internet)", () => {
  it("pricing CURRENT, billing HISTORICAL, compare MIXED; robots/off-origin/query honored", async () => {
    const { base, close } = await startAcme()
    try {
      // Scope: whole origin.
      const validated = validateScope(`${base}/`)
      const scope = { canonical_origin: validated.canonical_origin, path_prefix: validated.path_prefix }

      // Robots: allow-all except /private/.
      const robotsTxt = await (await fetch(`${base}/robots.txt`)).text()
      const rules = parseRobots(robotsTxt)
      expect(rules.sitemaps).toEqual([`${base}/sitemap.xml`])
      expect(isAllowed("/pricing", rules)).toBe(true)
      expect(isAllowed("/docs/billing", rules)).toBe(true)
      expect(isAllowed("/private/old-price", rules)).toBe(false)

      // Sitemap-first: 5 URLs.
      const sitemapXml = await (await fetch(`${base}/sitemap.xml`)).text()
      const parsed = parseSitemapXml(sitemapXml)
      expect(parsed.urls).toHaveLength(5)

      // Frontier from sitemap provenance.
      const frontier = buildFrontier({
        scope,
        candidates: parsed.urls.map((url) => ({ url, discoveredVia: "SITEMAP" as const, parentUrl: `${base}/sitemap.xml`, depth: 0 })),
      })
      expect(frontier.partial).toBe(false)
      expect(frontier.entries).toHaveLength(5)

      // Robots gate at fetch time: /private/old-price NOT FETCHED, no candidate.
      const fetched = frontier.entries.filter((e) => isAllowed(new URL(e.canonicalUrl).pathname, rules))
      expect(fetched.map((e) => e.canonicalUrl).some((u) => u.includes("/private/"))).toBe(false)

      // Authority: starter-price v1 $49 SUPERSEDED -> v2 $59 ACTIVE.
      const snapshot = buildAuthoritySnapshot([
        { id: "fact-v1", lineageRootId: "root-starter", version: 1, valueType: "CURRENCY", valueText: "49 USD", supersedesId: null },
        { id: "fact-v2", lineageRootId: "root-starter", version: 2, valueType: "CURRENCY", valueText: "59 USD", supersedesId: "fact-v1" },
      ])
      expect(snapshot.unsupported).toEqual([])
      const auth = { lineages: snapshot.lineages }

      const bodies = new Map<string, string>()
      for (const e of fetched) {
        bodies.set(e.canonicalUrl, await (await fetch(e.canonicalUrl)).text())
      }
      const pricingUrl = fetched.find((e) => e.canonicalUrl.endsWith("/pricing"))!.canonicalUrl
      const billingUrl = fetched.find((e) => e.canonicalUrl.endsWith("/billing"))!.canonicalUrl
      const compareUrl = fetched.find((e) => e.canonicalUrl.endsWith("/compare"))!.canonicalUrl
      const dynamicUrl = fetched.find((e) => e.canonicalUrl.endsWith("/dynamic"))!.canonicalUrl

      const summarize = (url: string) =>
        summarizeMatches({ pageUrl: url, pageObservationId: `obs-${url}`, runId: "run-1", events: matchPage(bodies.get(url)!, auth) })

      // /pricing -> CURRENT_VALUE_FOUND (never IN_SYNC).
      const pricing = summarize(pricingUrl)
      expect(pricing).toHaveLength(1)
      expect(pricing[0]!.state).toBe("CURRENT_VALUE_FOUND")

      // /docs/billing -> HISTORICAL_VALUE_FOUND (never DRIFT).
      const billing = summarize(billingUrl)
      expect(billing).toHaveLength(1)
      expect(billing[0]!.state).toBe("HISTORICAL_VALUE_FOUND")

      // /compare -> MIXED_KNOWN_VALUES.
      const compare = summarize(compareUrl)
      expect(compare).toHaveLength(1)
      expect(compare[0]!.state).toBe("MIXED_KNOWN_VALUES")

      // /dynamic shell -> no candidate (never "absent"/"in sync").
      expect(matchPage(bodies.get(dynamicUrl)!, auth)).toEqual([])
      expect(summarize(dynamicUrl)).toEqual([])

      // Snippet bound respected everywhere.
      for (const s of [...pricing, ...billing, ...compare]) {
        for (const m of [s.current_match, ...s.historical_matches]) {
          if (m) expect(m.snippet.length).toBeLessThanOrEqual(512)
        }
      }

      // Link fallback rules: query-bearing LINK skipped, off-origin out of scope.
      const linkFrontier = buildFrontier({
        scope,
        candidates: [
          { url: `${base}/pricing?campaign=x`, discoveredVia: "LINK", parentUrl: `${base}/`, depth: 1 },
          { url: "https://other.example/acme", discoveredVia: "LINK", parentUrl: `${base}/`, depth: 1 },
          { url: `${base}/dynamic`, discoveredVia: "LINK", parentUrl: `${base}/`, depth: 1 },
        ],
      })
      expect(linkFrontier.skipped.some((s) => s.url.includes("campaign") && s.reason === "QUERY_LINK_SKIPPED")).toBe(true)
      expect(linkFrontier.skipped.some((s) => s.url.includes("other.example") && s.reason === "OUT_OF_SCOPE")).toBe(true)
      expect(linkFrontier.entries.some((e) => e.canonicalUrl.endsWith("/dynamic"))).toBe(true)
      expect(isInScope(`${base}/dynamic`, scope)).toBe(true)
    } finally {
      await close()
    }
  })

  it("truth change $59->$69 reclassifies without claiming absence", async () => {
    const { base, close } = await startAcme()
    try {
      const snapshot = buildAuthoritySnapshot([
        { id: "fact-v1", lineageRootId: "root-starter", version: 1, valueType: "CURRENCY", valueText: "49 USD", supersedesId: null },
        { id: "fact-v2", lineageRootId: "root-starter", version: 2, valueType: "CURRENCY", valueText: "59 USD", supersedesId: "fact-v1" },
        { id: "fact-v3", lineageRootId: "root-starter", version: 3, valueType: "CURRENCY", valueText: "69 USD", supersedesId: "fact-v2" },
      ])
      const auth = { lineages: snapshot.lineages }
      expect(auth.lineages[0]!.currentValue).toBe("69 USD")
      expect(auth.lineages[0]!.historicalValues.map((h) => h.value).sort()).toEqual(["49 USD", "59 USD"])

      const pricingBody = await (await fetch(`${base}/pricing`)).text()
      const events = matchPage(pricingBody, auth)
      // $59 page is now a historical known value, not current.
      expect(events.some((e) => e.relation === "CURRENT_VALUE")).toBe(false)
      expect(events.some((e) => e.relation === "HISTORICAL_VALUE" && e.matchedValue === "59 USD")).toBe(true)
      const summaries = summarizeMatches({ pageUrl: `${base}/pricing`, pageObservationId: "obs-2", runId: "run-2", events })
      expect(summaries[0]!.state).toBe("HISTORICAL_VALUE_FOUND")
      // No page contains $69: that yields no CURRENT candidate, never an
      // "absent from site" claim (absence is not provable by a bounded scan).
    } finally {
      await close()
    }
  })
})
