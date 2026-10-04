// SafeHttpFetcher redirect-target policy: prefix scope applies BEFORE the
// redirect fetch, never after. Stub transport records every fetch call so
// tests prove a forbidden target was never requested.
import { describe, expect, it } from "vitest"
import { safeFetch, type FetchResponse, type HttpTransport } from "../src/safe-http.js"

const PEER = "93.184.216.34"

interface Route {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

const stubTransport = (routes: Record<string, Route>, calls: string[]): HttpTransport => ({
  lookup: async () => [PEER],
  fetch: async (url): Promise<FetchResponse> => {
    calls.push(url)
    const path = new URL(url).pathname
    const r = routes[path]
    if (!r) return { status: 404, headers: {}, body: new Uint8Array(0), peerIp: PEER }
    return { status: r.status, headers: r.headers, body: new TextEncoder().encode(r.body), peerIp: PEER }
  },
})

const SCOPE = "https://example.com"
const inDocsPrefix = (target: string): boolean => {
  const u = new URL(target)
  if (`${u.protocol}//${u.host}` !== SCOPE) return false
  const path = u.pathname || "/"
  return path === "/docs" || path === "/docs/" || path.startsWith("/docs/")
}

const fetchPage = (path: string, routes: Record<string, Route>, calls: string[]) =>
  safeFetch(`https://example.com${path}`, {
    transport: stubTransport(routes, calls),
    limits: { timeoutMs: 5000, maxRedirects: 5, maxBytes: 1_000_000, acceptedContentTypes: ["text/html"] },
    redirectPolicy: { maxRedirects: 5, allowCrossOrigin: false, scopeOrigin: SCOPE, isAllowedRedirect: inDocsPrefix },
  })

describe("redirect target scope", () => {
  it("A. same-prefix redirect is followed and fetched", async () => {
    const calls: string[] = []
    const ev = await fetchPage("/docs/a", {
      "/docs/a": { status: 302, headers: { location: "/docs/b" }, body: "" },
      "/docs/b": { status: 200, headers: { "content-type": "text/html" }, body: "<html>hi</html>" },
    }, calls)
    expect(ev.failure).toBeNull()
    expect(ev.finalUrl).toBe("https://example.com/docs/b")
    expect(calls).toEqual(["https://example.com/docs/a", "https://example.com/docs/b"])
  })

  it("B. out-of-prefix redirect is rejected WITHOUT fetching the target", async () => {
    const calls: string[] = []
    const ev = await fetchPage("/docs/a", {
      "/docs/a": { status: 302, headers: { location: "/private/b" }, body: "" },
      "/private/b": { status: 200, headers: { "content-type": "text/html" }, body: "<html>secret</html>" },
    }, calls)
    expect(ev.failure).toBe("OUT_OF_SCOPE_REDIRECT")
    expect(ev.outOfScopeRedirect).toBe("https://example.com/private/b")
    expect(calls).toEqual(["https://example.com/docs/a"])
  })

  it("C. cross-origin redirect is rejected and never fetched", async () => {
    const calls: string[] = []
    const ev = await fetchPage("/docs/a", {
      "/docs/a": { status: 302, headers: { location: "https://other.example/docs/b" }, body: "" },
    }, calls)
    expect(ev.failure).toBe("OUT_OF_SCOPE_REDIRECT")
    expect(calls).toEqual(["https://example.com/docs/a"])
  })

  it("D. chain stops at the first out-of-scope hop", async () => {
    const calls: string[] = []
    const ev = await fetchPage("/docs/a", {
      "/docs/a": { status: 302, headers: { location: "/docs/b" }, body: "" },
      "/docs/b": { status: 302, headers: { location: "/outside/c" }, body: "" },
      "/outside/c": { status: 200, headers: { "content-type": "text/html" }, body: "x" },
    }, calls)
    expect(ev.failure).toBe("OUT_OF_SCOPE_REDIRECT")
    expect(ev.outOfScopeRedirect).toBe("https://example.com/outside/c")
    expect(calls).toEqual(["https://example.com/docs/a", "https://example.com/docs/b"])
  })

  it("E. no scope callback preserves existing cross-origin behavior", async () => {
    const calls: string[] = []
    const ev = await safeFetch("https://example.com/docs/a", {
      transport: stubTransport({
        "/docs/a": { status: 302, headers: { location: "https://other.example/x" }, body: "" },
        "/x": { status: 200, headers: { "content-type": "text/html" }, body: "<html>x</html>" },
      }, calls),
      limits: { timeoutMs: 5000, maxRedirects: 5, maxBytes: 1_000_000, acceptedContentTypes: null },
      redirectPolicy: { maxRedirects: 5, allowCrossOrigin: true },
    })
    expect(ev.failure).toBeNull()
    expect(ev.finalUrl).toBe("https://other.example/x")
    expect(calls).toEqual(["https://example.com/docs/a", "https://other.example/x"])
  })
})
