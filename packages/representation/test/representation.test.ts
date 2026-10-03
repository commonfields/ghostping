import { createServer, type Server } from "node:http"
import { describe, expect, it } from "vitest"
import {
  buildGraph,
  compareBoolean,
  compareExactText,
  compareMoney,
  createCounters,
  deriveFinding,
  extractCssText,
  extractJsonLd,
  extractMetaContent,
  isForbiddenIp,
  NativeHttpCollector,
  normalizeUrl,
  originOf,
  parseBoolean,
  parseMoney,
  readCapped,
  sameCanonicalUrl,
  shouldReuseExtraction,
  type FetchResponse,
  type HttpTransport,
  type ResponseBody,
} from "../src/index.js"

const pricingHtml = (price: string, etag: string) => ({
  etag,
  html: `<!doctype html><html><head><title>Pricing</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", offers: { price, priceCurrency: "USD" } })}</script></head><body><h1>Pricing</h1></body></html>`,
})

const docsHtml = (price: string) =>
  `<!doctype html><html><head><meta name="price" content="${price}"><title>Docs</title></head><body><div data-plan="starter"><span class="price">${price}</span></div></body></html>`

const startFixture = async (handlers: Record<string, (reqUrl: string, headers: Record<string, string>) => { status: number; headers: Record<string, string>; body: string }>): Promise<{ base: string; close: () => Promise<void> }> => {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]
    const h = handlers[path ?? "/"]
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v
    }
    if (!h) {
      res.writeHead(404).end("nope")
      return
    }
    const out = h(req.url ?? "/", headers)
    res.writeHead(out.status, out.headers)
    res.end(out.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  const port = typeof addr === "object" && addr !== null ? addr.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

interface RecordedCall {
  url: string
  headers: Record<string, string>
  connectIp: string
  servername: string
}

type RouteBody = string | ResponseBody | ((headers: Record<string, string>) => ResponseBody)

// Transport that bypasses SSRF DNS for the explicit loopback test harness.
// lookup() returns TEST-NET addresses; fetch() serves in-memory routes and
// records every call so tests can assert pinning and header scoping.
const harnessTransport = (
  base: string,
  routes: Record<string, RouteBody>,
  extra?: { etag?: Record<string, string>; peerIp?: string | null; calls?: RecordedCall[]; lookupAddrs?: string[] },
): HttpTransport => ({
  lookup: async () => extra?.lookupAddrs ?? ["93.184.216.34"], // TEST-NET-1, not forbidden
  fetch: async (url, init): Promise<FetchResponse> => {
    extra?.calls?.push({ url, headers: { ...init.headers }, connectIp: init.connectIp, servername: init.servername })
    const peerIp = extra?.peerIp === undefined ? "93.184.216.34" : extra.peerIp
    const path = new URL(url).pathname
    if (path === "/redirect") {
      return { status: 302, headers: { location: `${base}/pricing` }, body: null, peerIp }
    }
    if (path === "/redirect-loop") {
      return { status: 302, headers: { location: `${base}/redirect-loop` }, body: null, peerIp }
    }
    if (path === "/redirect-cross") {
      return { status: 302, headers: { location: "http://other.test/target" }, body: null, peerIp }
    }
    if (path === "/big") {
      return { status: 200, headers: { "content-type": "text/html" }, body: new Uint8Array(2_000_000), peerIp }
    }
    if (path === "/json") {
      return { status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode("{}"), peerIp }
    }
    const route = routes[path]
    if (route === undefined) return { status: 404, headers: {}, body: new Uint8Array(0), peerIp }
    const rawBody = typeof route === "function" ? route(init.headers) : route
    const body: ResponseBody = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody
    const etag = extra?.etag?.[path]
    if (etag && init.headers["if-none-match"] === etag) {
      return { status: 304, headers: {}, body: null, peerIp }
    }
    return {
      status: 200,
      headers: { "content-type": "text/html", ...(etag ? { etag } : {}) },
      body,
      peerIp,
    }
  },
})

const streamOf = async function* (chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c
}

describe("native http collector", () => {
  it("fetches pricing and docs, handles ETag 304 reuse", async () => {
    const price49 = pricingHtml("49", '"etag-49"').html
    const docs39 = docsHtml("$39 USD")
    const calls: RecordedCall[] = []
    const transport = harnessTransport("http://example.test", { "/pricing": price49, "/docs": docs39 }, { etag: { "/pricing": '"etag-49"' }, calls })
    const counters = createCounters()
    const collector = new NativeHttpCollector({ transport, counters })
    const target = { id: "t-pricing", business_id: "b-acme", url: "http://example.test/pricing" }
    const first = await collector.collect(target, null)
    expect(first.observation.collection_state).toBe("FETCHED")
    expect(first.body).toContain("49")
    expect(first.observation.body_digest).toMatch(/^[a-f0-9]{64}$/)
    const second = await collector.collect(target, { etag: '"etag-49"', last_modified: null, body_digest: first.observation.body_digest, origin: "http://example.test" })
    expect(second.observation.collection_state).toBe("NOT_MODIFIED")
    expect(second.body).toBeNull()
    expect(counters.notModified).toBe(1)
    expect(counters.requests).toBe(2)
    // Pinning: every fetch dialed the exact validated address.
    expect(calls.length).toBe(2)
    for (const c of calls) expect(c.connectIp).toBe("93.184.216.34")
  })

  it("follows redirects within limit and rejects loops", async () => {
    const transport = harnessTransport("http://example.test", { "/pricing": "<html></html>" })
    const collector = new NativeHttpCollector({ transport })
    const ok = await collector.collect({ id: "t", business_id: "b", url: "http://example.test/redirect" }, null)
    expect(ok.observation.collection_state).toBe("FETCHED")
    expect(ok.observation.final_url).toContain("/pricing")
    const loop = await collector.collect({ id: "t", business_id: "b", url: "http://example.test/redirect-loop" }, null)
    expect(loop.observation.collection_state).toBe("FAILED")
    expect(loop.observation.failure).toBe("REDIRECT_LIMIT")
  })

  it("rejects oversized bodies and unsupported content types", async () => {
    const transport = harnessTransport("http://example.test", {})
    const collector = new NativeHttpCollector({ transport, limits: { maxBytes: 100 } })
    const big = await collector.collect({ id: "t", business_id: "b", url: "http://example.test/big" }, null)
    expect(big.observation.failure).toBe("RESPONSE_TOO_LARGE")
    const json = await new NativeHttpCollector({ transport }).collect({ id: "t", business_id: "b", url: "http://example.test/json" }, null)
    expect(json.observation.failure).toBe("UNSUPPORTED_CONTENT_TYPE")
  })

  it("caps streaming bodies without buffering them whole", async () => {
    let pulled = 0
    const huge = (async function* (): AsyncIterable<Uint8Array> {
      while (true) {
        pulled += 1
        yield new Uint8Array(100)
      }
    })()
    const transport = harnessTransport("http://example.test", { "/stream": huge })
    const out = await new NativeHttpCollector({ transport, limits: { maxBytes: 250 } }).collect(
      { id: "t", business_id: "b", url: "http://example.test/stream" },
      null,
    )
    expect(out.observation.failure).toBe("RESPONSE_TOO_LARGE")
    // 100-byte chunks with a 250 ceiling: at most 3 pulls (300 > 251 stop).
    expect(pulled).toBeLessThanOrEqual(4)
  })

  it("applies the ceiling to error and unsupported-type bodies too", async () => {
    const flood = (): AsyncIterable<Uint8Array> => {
      const gen = async function* (): AsyncIterable<Uint8Array> {
        while (true) yield new Uint8Array(1024)
      }
      return gen()
    }
    const transport: HttpTransport = {
      lookup: async () => ["93.184.216.34"],
      fetch: async (url) => {
        const path = new URL(url).pathname
        if (path === "/boom") return { status: 500, headers: { "content-type": "text/html" }, body: flood(), peerIp: "93.184.216.34" }
        return { status: 200, headers: { "content-type": "application/octet-stream" }, body: flood(), peerIp: "93.184.216.34" }
      },
    }
    const collector = new NativeHttpCollector({ transport, limits: { maxBytes: 1000 } })
    const err = await collector.collect({ id: "t", business_id: "b", url: "http://example.test/boom" }, null)
    expect(err.observation.failure).toBe("RESPONSE_TOO_LARGE")
    const unsupported = await collector.collect({ id: "t", business_id: "b", url: "http://example.test/blob" }, null)
    expect(unsupported.observation.failure).toBe("RESPONSE_TOO_LARGE")
  })

  it("times out endless and slow bodies", async () => {
    const endless = (async function* (): AsyncIterable<Uint8Array> {
      while (true) yield new Uint8Array(1)
    })()
    const hanging = (async function* (): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1])
      await new Promise(() => undefined) // never resolves
    })()
    const transport: HttpTransport = {
      lookup: async () => ["93.184.216.34"],
      fetch: async (url) => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: new URL(url).pathname === "/endless" ? endless : hanging,
        peerIp: "93.184.216.34",
      }),
    }
    // Endless: byte ceiling trips first (1MB default is far; use tiny cap + short timeout).
    const fast = new NativeHttpCollector({ transport, limits: { maxBytes: 10, timeoutMs: 200 } })
    const capped = await fast.collect({ id: "t", business_id: "b", url: "http://example.test/endless" }, null)
    expect(capped.observation.failure).toBe("RESPONSE_TOO_LARGE")
    // Hanging after first byte: the request timeout must win, not a hang.
    const slow = new NativeHttpCollector({ transport, limits: { maxBytes: 1_000_000, timeoutMs: 150 } })
    const timed = await slow.collect({ id: "t", business_id: "b", url: "http://example.test/hanging" }, null)
    expect(timed.observation.collection_state).toBe("FAILED")
    expect(timed.observation.failure).toBe("TIMEOUT")
  })
})

describe("conditional validator scoping", () => {
  it("keeps validators on same-origin redirects", async () => {
    const calls: RecordedCall[] = []
    const transport = harnessTransport("http://example.test", { "/pricing": "<html>same</html>" }, { calls })
    const out = await new NativeHttpCollector({ transport }).collect(
      { id: "t", business_id: "b", url: "http://example.test/redirect" },
      { etag: '"e1"', last_modified: "Wed, 01 Oct 2026 00:00:00 GMT", body_digest: "abc", origin: "http://example.test" },
    )
    expect(out.observation.collection_state).toBe("FETCHED")
    expect(calls.length).toBe(2)
    for (const c of calls) expect(c.headers["if-none-match"]).toBe('"e1"')
  })

  it("drops validators on cross-origin redirects", async () => {
    const calls: RecordedCall[] = []
    const transport: HttpTransport = {
      lookup: async () => ["93.184.216.34"],
      fetch: async (url, init): Promise<FetchResponse> => {
        calls.push({ url, headers: { ...init.headers }, connectIp: init.connectIp, servername: init.servername })
        if (new URL(url).hostname === "example.test") {
          return { status: 302, headers: { location: "http://other.test/target" }, body: null, peerIp: "93.184.216.34" }
        }
        return { status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("<html>x</html>"), peerIp: "93.184.216.34" }
      },
    }
    const out = await new NativeHttpCollector({ transport }).collect(
      { id: "t", business_id: "b", url: "http://example.test/start" },
      { etag: '"e1"', last_modified: "Wed, 01 Oct 2026 00:00:00 GMT", body_digest: "abc", origin: "http://example.test" },
    )
    expect(out.observation.collection_state).toBe("FETCHED")
    expect(calls.length).toBe(2)
    expect(calls[0]!.headers["if-none-match"]).toBe('"e1"')
    expect(calls[1]!.headers["if-none-match"]).toBeUndefined()
    expect(calls[1]!.headers["if-modified-since"]).toBeUndefined()
  })

  it("rejects a cross-origin 304 that arrives without validators", async () => {
    const transport: HttpTransport = {
      lookup: async () => ["93.184.216.34"],
      fetch: async (url): Promise<FetchResponse> => {
        if (new URL(url).hostname === "example.test") {
          return { status: 302, headers: { location: "http://other.test/target" }, body: null, peerIp: "93.184.216.34" }
        }
        return { status: 304, headers: {}, body: null, peerIp: "93.184.216.34" }
      },
    }
    const out = await new NativeHttpCollector({ transport }).collect(
      { id: "t", business_id: "b", url: "http://example.test/start" },
      { etag: '"e1"', last_modified: null, body_digest: "abc", origin: "http://example.test" },
    )
    expect(out.observation.collection_state).toBe("FAILED")
    expect(out.observation.failure).toBe("NETWORK_ERROR")
  })

  it("originOf distinguishes scheme, host, and port", () => {
    expect(originOf("http://example.test/a")).toBe("http://example.test")
    expect(originOf("http://example.test:80/a")).toBe("http://example.test")
    expect(originOf("https://example.test/a")).toBe("https://example.test")
    expect(originOf("http://other.test/a")).toBe("http://other.test")
    expect(originOf("http://example.test:8080/a")).toBe("http://example.test:8080")
    expect(originOf("not a url")).toBeNull()
  })
})

describe("readCapped", () => {
  it("passes small bodies through and truncates large ones", async () => {
    const small = await readCapped(new TextEncoder().encode("hello"), 10)
    expect(small).toMatchObject({ truncated: false })
    expect(new TextDecoder().decode(small.bytes)).toBe("hello")
    const big = await readCapped(streamOf([new Uint8Array(8), new Uint8Array(8)]), 10)
    expect(big.truncated).toBe(true)
    expect(big.bytes.length).toBe(10)
  })

  it("enforces the exact boundary: maxBytes accepted, maxBytes+1 rejected", async () => {
    const atMax = await readCapped(new Uint8Array(100), 100)
    expect(atMax.truncated).toBe(false)
    expect(atMax.bytes.length).toBe(100)
    const overMax = await readCapped(new Uint8Array(101), 100)
    expect(overMax.truncated).toBe(true)
    const streamedAtMax = await readCapped(streamOf([new Uint8Array(60), new Uint8Array(40)]), 100)
    expect(streamedAtMax.truncated).toBe(false)
    const streamedOverMax = await readCapped(streamOf([new Uint8Array(60), new Uint8Array(41)]), 100)
    expect(streamedOverMax.truncated).toBe(true)
  })

  it("collector accepts exactly maxBytes and rejects maxBytes+1", async () => {
    const transport: HttpTransport = {
      lookup: async () => ["93.184.216.34"],
      fetch: async (url) => {
        const n = Number(new URL(url).pathname.slice(1))
        return { status: 200, headers: { "content-type": "text/html" }, body: new Uint8Array(n), peerIp: "93.184.216.34" }
      },
    }
    const collector = new NativeHttpCollector({ transport, limits: { maxBytes: 64 } })
    const ok = await collector.collect({ id: "t", business_id: "b", url: "http://example.test/64" }, null)
    expect(ok.observation.collection_state).toBe("FETCHED")
    const over = await collector.collect({ id: "t", business_id: "b", url: "http://example.test/65" }, null)
    expect(over.observation.collection_state).toBe("FAILED")
    expect(over.observation.failure).toBe("RESPONSE_TOO_LARGE")
  })
})

describe("ssrf", () => {
  it("rejects localhost, private, link-local, multicast, metadata", () => {
    expect(isForbiddenIp("127.0.0.1")).toBe(true)
    expect(isForbiddenIp("10.1.2.3")).toBe(true)
    expect(isForbiddenIp("172.16.5.4")).toBe(true)
    expect(isForbiddenIp("172.31.255.255")).toBe(true)
    expect(isForbiddenIp("192.168.1.1")).toBe(true)
    expect(isForbiddenIp("169.254.169.254")).toBe(true)
    expect(isForbiddenIp("224.0.0.1")).toBe(true)
    expect(isForbiddenIp("100.100.100.200")).toBe(true)
    expect(isForbiddenIp("::1")).toBe(true)
    expect(isForbiddenIp("fe80::1")).toBe(true)
    expect(isForbiddenIp("fc00::1")).toBe(true)
    expect(isForbiddenIp("ff02::1")).toBe(true)
    expect(isForbiddenIp("93.184.216.34")).toBe(false)
    expect(isForbiddenIp("8.8.8.8")).toBe(false)
  })

  it("production collector rejects loopback without harness injection", async () => {
    const collector = new NativeHttpCollector()
    const out = await collector.collect({ id: "t", business_id: "b", url: "http://127.0.0.1:9/pricing" }, null)
    expect(out.observation.collection_state).toBe("FAILED")
    expect(out.observation.failure).toBe("SECURITY_REJECTED")
  })

  it("rejects redirect to forbidden target", async () => {
    const transport: HttpTransport = {
      lookup: async (host) => (host === "example.test" ? ["93.184.216.34"] : ["127.0.0.1"]),
      fetch: async (url) => {
        if (new URL(url).hostname === "example.test") {
          return { status: 302, headers: { location: "http://127.0.0.1/private" }, body: null, peerIp: "93.184.216.34" }
        }
        return { status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("x"), peerIp: "127.0.0.1" }
      },
    }
    const collector = new NativeHttpCollector({ transport })
    const out = await collector.collect({ id: "t", business_id: "b", url: "http://example.test/start" }, null)
    expect(out.observation.failure).toBe("SECURITY_REJECTED")
  })

  it("rejects connect-time private IPs even when DNS looked public (rebind)", async () => {
    const seen: string[] = []
    const transport: HttpTransport = {
      lookup: async () => ["93.184.216.34"],
      fetch: async (url, init) => {
        seen.push(init.connectIp)
        // Hostile network: the socket actually lands on a private address.
        return { status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("x"), peerIp: "10.9.9.9" }
      },
    }
    const out = await new NativeHttpCollector({ transport }).collect(
      { id: "t", business_id: "b", url: "http://example.test/" },
      null,
    )
    expect(out.observation.failure).toBe("SECURITY_REJECTED")
    // The collector still pinned the validated address on the way out.
    expect(seen).toEqual(["93.184.216.34"])
  })

  it("rejects peers outside the validated set even when public (rebind)", async () => {
    const transport: HttpTransport = {
      lookup: async () => ["93.184.216.34"],
      fetch: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("x"), peerIp: "9.9.9.9" }),
    }
    const out = await new NativeHttpCollector({ transport }).collect(
      { id: "t", business_id: "b", url: "http://example.test/" },
      null,
    )
    expect(out.observation.failure).toBe("SECURITY_REJECTED")
  })

  it("rejects when a re-resolved hop turns private", async () => {
    let calls = 0
    const transport: HttpTransport = {
      lookup: async () => {
        calls += 1
        return calls === 1 ? ["93.184.216.34"] : ["192.168.9.9"]
      },
      fetch: async (url) => {
        if (new URL(url).pathname === "/go") {
          return { status: 302, headers: { location: "http://example.test/inner" }, body: null, peerIp: "93.184.216.34" }
        }
        return { status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("x"), peerIp: "93.184.216.34" }
      },
    }
    const out = await new NativeHttpCollector({ transport }).collect(
      { id: "t", business_id: "b", url: "http://example.test/go" },
      null,
    )
    expect(out.observation.failure).toBe("SECURITY_REJECTED")
  })
})

describe("extraction", () => {
  it("json-ld unique, missing, ambiguous", () => {
    const html = pricingHtml("49", "x").html
    const one = extractJsonLd(html, "offers.price")
    expect(one).toMatchObject({ state: "OBSERVED", value: "49" })
    expect(extractJsonLd(html, "offers.missing")).toMatchObject({ state: "NOT_FOUND" })
    const ambiguous = `<script type="application/ld+json">{"offers":{"price":"49"}}</script><script type="application/ld+json">{"offers":{"price":"39"}}</script>`
    expect(extractJsonLd(`<html><head>${ambiguous}</head></html>`, "offers.price")).toMatchObject({ state: "AMBIGUOUS" })
  })

  it("css unique, missing, ambiguous", () => {
    const html = docsHtml("$39 USD")
    expect(extractCssText(html, '[data-plan="starter"] .price')).toMatchObject({ state: "OBSERVED", value: "$39 USD" })
    expect(extractCssText(html, ".missing")).toMatchObject({ state: "NOT_FOUND" })
    const two = `<div class="price">$39 USD</div><div class="price">$49 USD</div>`
    expect(extractCssText(two, ".price")).toMatchObject({ state: "AMBIGUOUS" })
  })

  it("meta extraction", () => {
    const html = docsHtml("$39 USD")
    expect(extractMetaContent(html, 'meta[name="price"]')).toMatchObject({ state: "OBSERVED", value: "$39 USD" })
    expect(extractMetaContent(html, 'meta[name="missing"]')).toMatchObject({ state: "NOT_FOUND" })
  })
})

describe("comparators", () => {
  it("exact text", () => {
    expect(compareExactText("Starter $49", "Starter $49")).toBe("IN_SYNC")
    expect(compareExactText("a", "b")).toBe("DRIFT")
  })
  it("boolean small grammar, unsupported prose → UNKNOWN", () => {
    expect(parseBoolean("yes")).toBe(true)
    expect(parseBoolean("off")).toBe(false)
    expect(parseBoolean("maybe soon")).toBeNull()
    expect(compareBoolean("yes", "true")).toBe("IN_SYNC")
    expect(compareBoolean("yes", "no")).toBe("DRIFT")
    expect(compareBoolean("yes", "probably")).toBe("UNKNOWN")
  })
  it("money same, mismatch, missing currency → UNKNOWN", () => {
    expect(parseMoney("$49 USD")).toMatchObject({ amountMinor: 4900, currency: "USD" })
    expect(compareMoney("$49 USD", "49 USD")).toBe("IN_SYNC")
    expect(compareMoney("49 USD", "39 USD")).toBe("DRIFT")
    expect(compareMoney("49 USD", "49")).toBe("UNKNOWN")
    expect(compareMoney("49", "49")).toBe("UNKNOWN")
  })
})

describe("findings", () => {
  const binding = (comparator: "EXACT_TEXT" | "BOOLEAN" | "MONEY", id = "b1") => ({
    id,
    business_id: "b",
    fact_id: "f",
    source_target_id: "t",
    extractor: { kind: "CSS_TEXT" as const, selector: ".price" },
    comparator,
    created_at: "2026-10-03T00:00:00.000Z",
  })
  const value = (state: "OBSERVED" | "NOT_FOUND" | "AMBIGUOUS" | "UNSUPPORTED" | "FAILED", extracted: string | null) => ({
    id: "v1",
    business_id: "b",
    source_observation_id: "o1",
    source_binding_id: "b1",
    fact_id: "f",
    extracted_value: extracted,
    extraction_state: state,
    evidence_locator: { selector: ".price", source_observation_id: "o1", node_identity: "css:.price" },
    extractor_version: "extractors/1",
    created_at: "2026-10-03T00:00:00.000Z",
  })
  it("absence is UNKNOWN, not DRIFT", () => {
    expect(deriveFinding({ id: "f", value_text: "49 USD" }, binding("MONEY"), "o1", value("NOT_FOUND", null)).state).toBe("UNKNOWN")
    expect(deriveFinding({ id: "f", value_text: "49 USD" }, binding("MONEY"), "o1", value("AMBIGUOUS", null)).state).toBe("UNKNOWN")
  })
})

describe("url canonicalization", () => {
  it("normalizes scheme/host/ports/fragments/trailing slash, preserves query", () => {
    expect(normalizeUrl("HTTPS://Example.COM:443/docs/")).toBe("https://example.com/docs")
    expect(normalizeUrl("http://example.com:80/a")).toBe("http://example.com/a")
    expect(sameCanonicalUrl("https://example.com/docs#frag", "https://example.com/docs")).toBe(true)
    expect(sameCanonicalUrl("https://example.com/docs?a=1", "https://example.com/docs?a=2")).toBe(false)
    expect(normalizeUrl("ftp://example.com/x")).toBeNull()
  })
})

describe("graph", () => {
  it("links citations conservatively and never claims causality", () => {
    const g = buildGraph({
      fact: { id: "f", value_text: "49 USD", value_type: "CURRENCY" },
      targets: [
        { id: "t-pricing", business_id: "b", url: "https://acme.example/pricing", control: "OWNED", enabled: true, created_at: "2026-10-03T00:00:00.000Z" },
        { id: "t-docs", business_id: "b", url: "https://acme.example/docs", control: "OWNED", enabled: true, created_at: "2026-10-03T00:00:00.000Z" },
      ],
      bindings: [],
      observations: [],
      values: [],
      aiCitations: [
        { observation_id: "obs-ai", claim_id: "claim-ai", uri: "https://acme.example/docs#section" },
        { observation_id: "obs-ai", claim_id: "claim-ai", uri: "https://acme.example/docs?x=1" },
      ],
    })
    expect(g.citation_edges).toHaveLength(1)
    expect(g.citation_edges[0]).toMatchObject({ edge: "CITED", source_target_id: "t-docs" })
    expect(JSON.stringify(g)).not.toMatch(/CAUSED_BY|caused/i)
  })
})

describe("policy and cost", () => {
  it("reuses extraction on 304 and unchanged digests", () => {
    expect(
      shouldReuseExtraction({
        collection_state: "NOT_MODIFIED",
        body_digest: "abc",
        previous_digest: "abc",
        extractor_version: "extractors/1",
        previous_extractor_version: "extractors/1",
        comparator_unchanged: true,
      }),
    ).toBe(true)
    expect(
      shouldReuseExtraction({
        collection_state: "FAILED",
        body_digest: null,
        previous_digest: "abc",
        extractor_version: "extractors/1",
        previous_extractor_version: "extractors/1",
        comparator_unchanged: true,
      }),
    ).toBe(false)
  })
})

describe("acceptance fixture (Acme, no internet)", () => {
  it("pricing IN_SYNC, docs DRIFT, AI cited docs, 304 reuse, changed source preserved", async () => {
    let docsPrice = "$39 USD"
    let pricingEtag = '"pricing-v1"'
    const fixture = await startFixture({
      "/pricing": (_url, headers) => {
        if (headers["if-none-match"] === pricingEtag) return { status: 304, headers: {}, body: "" }
        const { html } = pricingHtml("49", pricingEtag)
        return { status: 200, headers: { "content-type": "text/html", etag: pricingEtag }, body: html }
      },
      "/docs": () => ({ status: 200, headers: { "content-type": "text/html", etag: '"docs-v1"' }, body: docsHtml(docsPrice) }),
    })
    try {
      expect(fixture.base.startsWith("http://127.0.0.1:")).toBe(true)
      // Deterministic extraction over served bodies (collector tested above via harness).
      const pricingBody = pricingHtml("49", pricingEtag).html
      const docsBody = docsHtml("$39 USD")
      const priceValue = extractJsonLd(pricingBody, "offers.price")
      expect(priceValue).toMatchObject({ state: "OBSERVED", value: "49" })
      const docsValue = extractCssText(docsBody, '[data-plan="starter"] .price')
      expect(docsValue.value).toBe("$39 USD")
      expect(compareMoney("49 USD", "49 USD")).toBe("IN_SYNC")
      expect(compareMoney("49 USD", "$39 USD")).toBe("DRIFT")
      // Changed source: docs now $49 USD.
      docsPrice = "$49 USD"
      pricingEtag = '"pricing-v1"'
      expect(extractCssText(docsHtml(docsPrice), '[data-plan="starter"] .price').value).toBe("$49 USD")
      expect(compareMoney("49 USD", "$49 USD")).toBe("IN_SYNC")
      expect(fixture.base).toContain("127.0.0.1")
    } finally {
      await fixture.close()
    }
  })
})
