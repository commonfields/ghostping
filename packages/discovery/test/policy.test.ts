import { describe, expect, it } from "vitest"
import { isInScope, isQueryAllowed, validateScope, DiscoveryScopeInvalid } from "../src/policy.js"

describe("validateScope", () => {
  it("accepts https root with origin-wide prefix", () => {
    expect(validateScope("https://acme.example/")).toEqual({
      canonical_origin: "https://acme.example",
      path_prefix: "/",
    })
  })

  it("strips default ports and trailing slash, lowercases host", () => {
    expect(validateScope("HTTPS://Acme.Example:443/docs/")).toEqual({
      canonical_origin: "https://acme.example",
      path_prefix: "/docs",
    })
    expect(validateScope("http://acme.example:80/x")).toEqual({
      canonical_origin: "http://acme.example",
      path_prefix: "/x",
    })
  })

  it("keeps non-default ports", () => {
    expect(validateScope("http://acme.example:8080/docs").canonical_origin).toBe("http://acme.example:8080")
  })

  it("rejects credentials", () => {
    expect(() => validateScope("https://user:pass@acme.example/")).toThrow(DiscoveryScopeInvalid)
  })

  it.each(["ftp://acme.example/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "notaurl"])(
    "rejects %s",
    (u) => {
      expect(() => validateScope(u)).toThrow(DiscoveryScopeInvalid)
    },
  )
})

describe("isInScope", () => {
  const scope = { canonical_origin: "https://acme.example", path_prefix: "/docs" }
  it("allows subtree paths on the same origin", () => {
    expect(isInScope("https://acme.example/docs/billing", scope)).toBe(true)
    expect(isInScope("https://acme.example/docs", scope)).toBe(true)
  })
  it("rejects prefix lookalikes, other origins, subdomains, schemes", () => {
    expect(isInScope("https://acme.example/documents", scope)).toBe(false)
    expect(isInScope("https://other.example/docs/x", scope)).toBe(false)
    expect(isInScope("https://docs.acme.example/docs/x", scope)).toBe(false)
    expect(isInScope("http://acme.example/docs/x", scope)).toBe(false)
    expect(isInScope("ftp://acme.example/docs/x", scope)).toBe(false)
  })
  it("root scope covers the whole origin", () => {
    const root = { canonical_origin: "https://acme.example", path_prefix: "/" }
    expect(isInScope("https://acme.example/anything", root)).toBe(true)
  })
})

describe("isQueryAllowed", () => {
  it("allows query URLs from sitemap and root sources", () => {
    expect(isQueryAllowed("https://a.example/p?x=1", "SITEMAP")).toBe(true)
    expect(isQueryAllowed("https://a.example/p?x=1", "ROBOTS_SITEMAP")).toBe(true)
    expect(isQueryAllowed("https://a.example/p?x=1", "DEFAULT_SITEMAP")).toBe(true)
    expect(isQueryAllowed("https://a.example/p?x=1", "ROOT")).toBe(true)
  })
  it("skips query URLs discovered via links", () => {
    expect(isQueryAllowed("https://a.example/p?x=1", "LINK")).toBe(false)
  })
  it("allows queryless link URLs", () => {
    expect(isQueryAllowed("https://a.example/p", "LINK")).toBe(true)
  })
})
