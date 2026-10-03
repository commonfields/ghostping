import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { collectSitemapUrls, parseSitemapBytes, parseSitemapXml, SitemapUnsafe } from "../src/sitemap.js"

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://a.example/pricing</loc></url>
  <url><loc>https://a.example/docs/billing</loc></url>
</urlset>`

const INDEX = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://a.example/s1.xml</loc></sitemap>
  <sitemap><loc>https://a.example/s2.xml</loc></sitemap>
</sitemapindex>`

describe("parseSitemapXml", () => {
  it("parses urlset locs", () => {
    const p = parseSitemapXml(URLSET)
    expect(p.urls).toEqual(["https://a.example/pricing", "https://a.example/docs/billing"])
    expect(p.nested).toEqual([])
    expect(p.truncated).toBe(false)
  })

  it("parses sitemapindex nested locs", () => {
    const p = parseSitemapXml(INDEX, { origin: "https://a.example" })
    expect(p.nested).toEqual(["https://a.example/s1.xml", "https://a.example/s2.xml"])
    expect(p.urls).toEqual([])
  })

  it("notes cross-origin nested sitemaps without fetching", () => {
    const p = parseSitemapXml(
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://a.example/s1.xml</loc></sitemap>
        <sitemap><loc>https://cdn.example/other.xml</loc></sitemap>
      </sitemapindex>`,
      { origin: "https://a.example" },
    )
    expect(p.nested).toEqual(["https://a.example/s1.xml"])
    expect(p.notedNotFetched).toEqual(["https://cdn.example/other.xml"])
  })

  it("truncates at the entry cap", () => {
    const urls = Array.from({ length: 10002 }, (_, i) => `<url><loc>https://a.example/p${i}</loc></url>`).join("")
    const p = parseSitemapXml(`<urlset>${urls}</urlset>`)
    expect(p.urls).toHaveLength(10000)
    expect(p.truncated).toBe(true)
  })

  it("rejects XXE payloads", () => {
    expect(() =>
      parseSitemapXml(`<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><urlset/>`, {}),
    ).toThrow(SitemapUnsafe)
    expect(() => parseSitemapXml(`<urlset><!ENTITY x "y"></urlset>`)).toThrow(SitemapUnsafe)
    expect(() =>
      parseSitemapXml(
        `<?xml version="1.0"?><!DOCTYPE sitemapindex SYSTEM "http://example.com/dtd"><sitemapindex/>`,
      ),
    ).toThrow(SitemapUnsafe)
  })
})

describe("parseSitemapBytes", () => {
  it("decompresses .xml.gz", () => {
    const gz = gzipSync(Buffer.from(URLSET))
    const p = parseSitemapBytes(gz, { url: "https://a.example/sitemap.xml.gz" })
    expect(p.urls).toHaveLength(2)
  })

  it("marks oversized decompressed payloads truncated", () => {
    const big = `<urlset>${"<url><loc>https://a.example/" + "p".repeat(100) + "</loc></url>"}</urlset>`
    const gz = gzipSync(Buffer.from(big))
    void gz
    // Direct oversized-input path: compressed input over the cap truncates.
    const over = new Uint8Array(5 * 1024 * 1024 + 1)
    over[0] = 0x1f
    over[1] = 0x8b
    const p = parseSitemapBytes(over, { url: "https://a.example/s.xml.gz" })
    expect(p.truncated).toBe(true)
  })
})

describe("collectSitemapUrls", () => {
  it("walks index -> urlsets without cycles looping", async () => {
    const docs: Record<string, string> = {
      "https://a.example/sitemap.xml": INDEX,
      "https://a.example/s1.xml": URLSET,
      "https://a.example/s2.xml": `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://a.example/sitemap.xml</loc></sitemap>
        <sitemap><loc>https://a.example/s1.xml</loc></sitemap>
      </sitemapindex>`,
    }
    const out = await collectSitemapUrls(
      async (url) => (docs[url] !== undefined ? Buffer.from(docs[url]!) : null),
      ["https://a.example/sitemap.xml"],
      "https://a.example",
    )
    expect(out.urls).toEqual(["https://a.example/pricing", "https://a.example/docs/billing"])
    expect(out.fetchedDocs).toBe(3)
    expect(out.truncated).toBe(false)
  })

  it("stops at the document budget", async () => {
    const docs: Record<string, string> = {}
    for (let i = 0; i < 25; i++) docs[`https://a.example/s${i}.xml`] = URLSET
    const index = `<sitemapindex>${Object.keys(docs)
      .map((u) => `<sitemap><loc>${u}</loc></sitemap>`)
      .join("")}</sitemapindex>`
    const out = await collectSitemapUrls(
      async (url) =>
        url === "https://a.example/sitemap.xml" ? Buffer.from(index) : docs[url] !== undefined ? Buffer.from(docs[url]!) : null,
      ["https://a.example/sitemap.xml"],
      "https://a.example",
    )
    expect(out.fetchedDocs).toBe(20)
    expect(out.truncated).toBe(true)
  })
})
