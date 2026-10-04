import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { DISCOVERY_BUDGETS_V1 } from "../src/types.js"
import {
  collectSitemapUrls,
  decodeSitemapBytes,
  isGzipBytes,
  parseSitemapBytes,
  parseSitemapXml,
  SitemapGzipError,
  SitemapUnsafe,
} from "../src/sitemap.js"

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

const CAP = DISCOVERY_BUDGETS_V1.sitemapDecompressedBytes

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

describe("isGzipBytes", () => {
  it("detects magic bytes only", () => {
    expect(isGzipBytes(gzipSync(Buffer.from(URLSET)))).toBe(true)
    expect(isGzipBytes(Buffer.from(URLSET))).toBe(false)
    expect(isGzipBytes(new Uint8Array(0))).toBe(false)
    expect(isGzipBytes(new Uint8Array([0x1f]))).toBe(false)
    expect(isGzipBytes(new Uint8Array([0x1f, 0x8b]))).toBe(true)
  })
})

describe("decodeSitemapBytes (canonical gzip path)", () => {
  it("passes plain .xml through", () => {
    const d = decodeSitemapBytes(Buffer.from(URLSET), { url: "https://a.example/sitemap.xml" })
    expect(d.truncated).toBe(false)
    expect(d.xml).toBe(URLSET)
  })

  it("decompresses .xml.gz URL via magic", () => {
    const gz = gzipSync(Buffer.from(URLSET))
    expect(gz.length).toBeGreaterThan(2)
    const d = decodeSitemapBytes(gz, { url: "https://a.example/sitemap.xml.gz" })
    expect(d.truncated).toBe(false)
    expect(d.xml).toBe(URLSET)
  })

  it("decompresses magic-bytes-without-suffix", () => {
    const gz = gzipSync(Buffer.from(URLSET))
    const d = decodeSitemapBytes(gz, { url: "https://a.example/sitemap.xml" })
    expect(d.truncated).toBe(false)
    expect(d.xml).toBe(URLSET)
  })

  it("is idempotent-safe: plain XML with .gz suffix passes through (no double-gunzip)", () => {
    const plain = Buffer.from(URLSET)
    const d = decodeSitemapBytes(plain, { url: "https://a.example/sitemap.xml.gz" })
    expect(d.truncated).toBe(false)
    expect(d.xml).toBe(URLSET)
    // parse side agrees: already-decompressed bytes yield the same urls
    const p = parseSitemapBytes(plain, { url: "https://a.example/sitemap.xml.gz" })
    expect(p.urls).toEqual(["https://a.example/pricing", "https://a.example/docs/billing"])
    expect(p.truncated).toBe(false)
  })

  it("rejects a tiny bomb without unbounded allocation", () => {
    const bomb = Buffer.alloc(6 * 1024 * 1024, 0)
    const gz = gzipSync(bomb)
    // Tiny relative to output: ~6KB compressing 6MB.
    expect(gz.length).toBeLessThan(100 * 1024)
    const d = decodeSitemapBytes(gz, { url: "https://a.example/s.xml.gz" })
    expect(d.truncated).toBe(true)
    expect(d.xml).toBe("")
  })

  it("enforces the exact per-document boundary for gzip (N accepted, N+1 rejected)", () => {
    const atCap = gzipSync(Buffer.alloc(CAP, 0x41))
    const overCap = gzipSync(Buffer.alloc(CAP + 1, 0x41))
    const ok = decodeSitemapBytes(atCap, { url: "https://a.example/s.xml.gz" })
    expect(ok.truncated).toBe(false)
    expect(Buffer.byteLength(ok.xml)).toBe(CAP)
    const over = decodeSitemapBytes(overCap, { url: "https://a.example/s.xml.gz" })
    expect(over.truncated).toBe(true)
  })

  it("enforces the exact per-document boundary for plain XML (N accepted, N+1 truncated)", () => {
    const ok = decodeSitemapBytes(Buffer.alloc(CAP, 0x78), { url: "https://a.example/sitemap.xml" })
    expect(ok.truncated).toBe(false)
    expect(Buffer.byteLength(ok.xml)).toBe(CAP)
    const over = decodeSitemapBytes(Buffer.alloc(CAP + 1, 0x78), { url: "https://a.example/sitemap.xml" })
    expect(over.truncated).toBe(true)
    expect(Buffer.byteLength(over.xml)).toBe(CAP)
  })

  it("throws a deterministic typed error for invalid gzip", () => {
    const bad = new Uint8Array([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03])
    expect(() => decodeSitemapBytes(bad, { url: "https://a.example/s.xml.gz" })).toThrow(SitemapGzipError)
    let first = ""
    let second = ""
    try {
      decodeSitemapBytes(bad, { url: "https://a.example/s.xml" })
    } catch (e) {
      expect(e).toBeInstanceOf(SitemapGzipError)
      first = String((e as Error).message)
    }
    try {
      decodeSitemapBytes(bad, { url: "https://a.example/s.xml" })
    } catch (e) {
      second = String((e as Error).message)
    }
    expect(first).not.toBe("")
    expect(second).toBe(first)
    expect(() => parseSitemapBytes(bad, { url: "https://a.example/s.xml.gz" })).toThrow(SitemapGzipError)
  })

  it("keeps the cap per document (no cumulative total)", () => {
    // Two near-cap documents back-to-back must both be accepted.
    const doc = gzipSync(Buffer.alloc(CAP - 10, 0x41))
    const a = decodeSitemapBytes(doc, { url: "https://a.example/a.xml.gz" })
    const b = decodeSitemapBytes(doc, { url: "https://a.example/b.xml.gz" })
    expect(a.truncated).toBe(false)
    expect(b.truncated).toBe(false)
  })
})

describe("parseSitemapBytes", () => {
  it("decompresses .xml.gz", () => {
    const gz = gzipSync(Buffer.from(URLSET))
    const p = parseSitemapBytes(gz, { url: "https://a.example/sitemap.xml.gz" })
    expect(p.urls).toHaveLength(2)
  })

  it("parses magic-bytes-without-suffix", () => {
    const gz = gzipSync(Buffer.from(URLSET))
    const p = parseSitemapBytes(gz, { url: "https://a.example/sitemap.xml" })
    expect(p.urls).toEqual(["https://a.example/pricing", "https://a.example/docs/billing"])
  })

  it("parses a nested .xml.gz index", () => {
    const gz = gzipSync(Buffer.from(INDEX))
    const p = parseSitemapBytes(gz, { url: "https://a.example/sitemap.xml.gz", origin: "https://a.example" })
    expect(p.nested).toEqual(["https://a.example/s1.xml", "https://a.example/s2.xml"])
  })

  it("marks gzip bombs truncated without throwing", () => {
    const gz = gzipSync(Buffer.alloc(6 * 1024 * 1024, 0))
    const p = parseSitemapBytes(gz, { url: "https://a.example/s.xml.gz" })
    expect(p.truncated).toBe(true)
    expect(p.urls).toEqual([])
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

  it("walks a nested .xml.gz index", async () => {
    const gzIndex = gzipSync(Buffer.from(INDEX))
    const out = await collectSitemapUrls(
      async (url) => {
        if (url === "https://a.example/sitemap.xml.gz") return new Uint8Array(gzIndex)
        if (url === "https://a.example/s1.xml") return Buffer.from(URLSET)
        if (url === "https://a.example/s2.xml") return Buffer.from(URLSET)
        return null
      },
      ["https://a.example/sitemap.xml.gz"],
      "https://a.example",
    )
    expect(out.urls).toEqual(["https://a.example/pricing", "https://a.example/docs/billing"])
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
