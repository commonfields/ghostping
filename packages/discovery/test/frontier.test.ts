import { describe, expect, it } from "vitest"
import { buildFrontier, classifyRedirect } from "../src/frontier.js"

const SCOPE = { canonical_origin: "https://acme.example", path_prefix: "/" }

describe("buildFrontier", () => {
  it("is deterministic under shuffled input and dedupes fragments", () => {
    const candidates = [
      { url: "https://acme.example/b", discoveredVia: "SITEMAP" as const, parentUrl: null, depth: 0 },
      { url: "https://acme.example/a", discoveredVia: "SITEMAP" as const, parentUrl: null, depth: 0 },
      { url: "https://acme.example/a#frag", discoveredVia: "LINK" as const, parentUrl: "https://acme.example/", depth: 1 },
      { url: "https://acme.example/b", discoveredVia: "LINK" as const, parentUrl: "https://acme.example/", depth: 1 },
    ]
    const once = buildFrontier({ scope: SCOPE, candidates })
    const shuffled = buildFrontier({ scope: SCOPE, candidates: [...candidates].reverse() })
    expect(once.entries.map((e) => e.canonicalUrl)).toEqual([
      "https://acme.example/a",
      "https://acme.example/b",
    ])
    expect(shuffled.entries.map((e) => e.canonicalUrl)).toEqual(
      once.entries.map((e) => e.canonicalUrl),
    )
    // SITEMAP provenance wins over LINK on merge.
    expect(once.entries[0]!.discoveredVia).toBe("SITEMAP")
  })

  it("keeps sitemap query URLs but skips link query URLs", () => {
    const out = buildFrontier({
      scope: SCOPE,
      candidates: [
        { url: "https://acme.example/p?x=1", discoveredVia: "SITEMAP", parentUrl: null, depth: 0 },
        { url: "https://acme.example/q?y=2", discoveredVia: "LINK", parentUrl: "https://acme.example/", depth: 1 },
      ],
    })
    expect(out.entries.map((e) => e.canonicalUrl)).toEqual(["https://acme.example/p?x=1"])
    expect(out.skipped).toContainEqual({ url: "https://acme.example/q?y=2", reason: "QUERY_LINK_SKIPPED" })
  })

  it("enforces link depth 2 while sitemap sources ignore depth", () => {
    const out = buildFrontier({
      scope: SCOPE,
      candidates: [
        { url: "https://acme.example/deep", discoveredVia: "LINK", parentUrl: "https://acme.example/x", depth: 3 },
        { url: "https://acme.example/ok", discoveredVia: "LINK", parentUrl: "https://acme.example/x", depth: 2 },
        { url: "https://acme.example/sm", discoveredVia: "SITEMAP", parentUrl: null, depth: 99 },
      ],
    })
    const urls = out.entries.map((e) => e.canonicalUrl)
    expect(urls).toContain("https://acme.example/ok")
    expect(urls).toContain("https://acme.example/sm")
    expect(out.skipped).toContainEqual({ url: "https://acme.example/deep", reason: "DEPTH_EXCEEDED" })
  })

  it("marks PARTIAL with BUDGET_EXHAUSTED overflow", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      url: `https://acme.example/p${i}`,
      discoveredVia: "SITEMAP" as const,
      parentUrl: null,
      depth: 0,
    }))
    const out = buildFrontier({ scope: SCOPE, candidates, maxPages: 3 })
    expect(out.entries).toHaveLength(3)
    expect(out.partial).toBe(true)
    expect(out.skipped.filter((s) => s.reason === "BUDGET_EXHAUSTED")).toHaveLength(7)
  })

  it("skips out-of-scope URLs", () => {
    const out = buildFrontier({
      scope: SCOPE,
      candidates: [
        { url: "https://evil.example/x", discoveredVia: "LINK", parentUrl: "https://acme.example/", depth: 1 },
      ],
    })
    expect(out.entries).toHaveLength(0)
    expect(out.skipped).toContainEqual({ url: "https://evil.example/x", reason: "OUT_OF_SCOPE" })
  })
})

describe("classifyRedirect", () => {
  it("flags cross-origin redirect targets", () => {
    expect(classifyRedirect("https://acme.example/next", SCOPE)).toEqual({ ok: true })
    expect(classifyRedirect("https://evil.example/next", SCOPE)).toEqual({
      ok: false,
      reason: "OUT_OF_SCOPE_REDIRECT",
    })
  })
})
