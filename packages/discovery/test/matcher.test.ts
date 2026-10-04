import { describe, expect, it } from "vitest"
import { matchPage, summarizeMatches, MIN_VISIBLE_TEXT_LENGTH, type AuthoritySnapshot } from "../src/matcher.js"
import { MATCHER_VERSION } from "../src/types.js"

const moneyLineage = (current: string, historical: { factId: string; version: number; value: string }[] = []) => ({
  rootId: "root-price",
  activeId: "fact-v2",
  activeVersion: 2,
  valueType: "CURRENCY" as const,
  currentValue: current,
  historicalValues: historical,
})

describe("matcher", () => {
  it("matches $49 current money in visible text against 49 USD authority", () => {
    const snap: AuthoritySnapshot = { lineages: [moneyLineage("49.00 USD")] }
    const events = matchPage("<html><body><p>Only $49 today</p></body></html>", snap)
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]).toMatchObject({ relation: "CURRENT_VALUE", surface: "VISIBLE_TEXT" })
  })

  it("handles JPY zero-decimal money", () => {
    const snap: AuthoritySnapshot = { lineages: [moneyLineage("1000 JPY")] }
    const events = matchPage("<html><body><p>Price: 1000 JPY</p></body></html>", snap)
    expect(events.some((e) => e.relation === "CURRENT_VALUE")).toBe(true)
  })

  it("pairs object-local price + priceCurrency in JSON-LD", () => {
    const snap: AuthoritySnapshot = { lineages: [moneyLineage("49.00 USD")] }
    const html = `<html><head><script type="application/ld+json">{"@type":"Offer","price":"49.00","priceCurrency":"USD"}</script></head><body></body></html>`
    const events = matchPage(html, snap)
    expect(events.some((e) => e.surface === "JSON_LD" && e.relation === "CURRENT_VALUE")).toBe(true)
  })

  it("matches exact text in META content", () => {
    const snap: AuthoritySnapshot = {
      lineages: [
        {
          rootId: "root-tag",
          activeId: "f1",
          activeVersion: 1,
          valueType: "TEXT",
          currentValue: "Acme Cloud Suite",
          historicalValues: [],
        },
      ],
    }
    const html = `<html><head><meta name="description" content="Acme Cloud Suite"></head><body></body></html>`
    const events = matchPage(html, snap)
    expect(events.some((e) => e.surface === "META")).toBe(true)
  })

  it("never matches booleans from visible prose, but does from META", () => {
    const snap: AuthoritySnapshot = {
      lineages: [
        { rootId: "root-b", activeId: "f1", activeVersion: 1, valueType: "BOOLEAN", currentValue: "true", historicalValues: [] },
      ],
    }
    const prose = matchPage("<html><body><p>yes this is true and enabled</p></body></html>", snap)
    expect(prose.filter((e) => e.surface === "VISIBLE_TEXT")).toHaveLength(0)
    const meta = matchPage(
      `<html><head><meta name="active" content="true"></head><body></body></html>`,
      snap,
    )
    expect(meta.some((e) => e.surface === "META" && e.relation === "CURRENT_VALUE")).toBe(true)
  })

  it("rejects short visible-text values below the threshold", () => {
    expect(MIN_VISIBLE_TEXT_LENGTH).toBe(4)
    const snap: AuthoritySnapshot = {
      lineages: [
        { rootId: "r", activeId: "f1", activeVersion: 1, valueType: "TEXT", currentValue: "abc", historicalValues: [] },
      ],
    }
    expect(matchPage("<html><body><p>abc</p></body></html>", snap)).toHaveLength(0)
  })

  it("requires token boundaries for visible text", () => {
    const snap: AuthoritySnapshot = {
      lineages: [
        { rootId: "r", activeId: "f1", activeVersion: 1, valueType: "TEXT", currentValue: "Acme", historicalValues: [] },
      ],
    }
    expect(matchPage("<html><body><p>AcmeCorp</p></body></html>", snap).filter((e) => e.surface === "VISIBLE_TEXT")).toHaveLength(0)
    expect(matchPage("<html><body><p>Buy Acme today</p></body></html>", snap).some((e) => e.surface === "VISIBLE_TEXT")).toBe(true)
  })

  it("excludes script contents from visible text", () => {
    const snap: AuthoritySnapshot = {
      lineages: [
        { rootId: "r", activeId: "f1", activeVersion: 1, valueType: "TEXT", currentValue: "SecretPhraseXYZ", historicalValues: [] },
      ],
    }
    const html = `<html><head><script>var x = "SecretPhraseXYZ";</script></head><body><p>hello</p></body></html>`
    expect(matchPage(html, snap).filter((e) => e.surface === "VISIBLE_TEXT")).toHaveLength(0)
  })

  it("ignores malformed JSON-LD blocks but reads valid ones", () => {
    const snap: AuthoritySnapshot = {
      lineages: [
        { rootId: "r", activeId: "f1", activeVersion: 1, valueType: "TEXT", currentValue: "Acme Price Plans", historicalValues: [] },
      ],
    }
    const html = `<html><head>
      <script type="application/ld+json">{not json</script>
      <script type="application/ld+json">{"name":"Acme Price Plans"}</script>
    </head><body></body></html>`
    expect(matchPage(html, snap).some((e) => e.surface === "JSON_LD")).toBe(true)
  })

  it("groups current + historical into MIXED_KNOWN_VALUES", () => {
    const snap: AuthoritySnapshot = {
      lineages: [moneyLineage("59.00 USD", [{ factId: "fact-v1", version: 1, value: "49.00 USD" }])],
    }
    const html = `<html><body><p>Now $59, was $49</p></body></html>`
    const events = matchPage(html, snap)
    expect(events.some((e) => e.relation === "CURRENT_VALUE")).toBe(true)
    expect(events.some((e) => e.relation === "HISTORICAL_VALUE")).toBe(true)
    const summaries = summarizeMatches({ pageUrl: "https://a.example/compare", pageObservationId: "o1", runId: "r1", events })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.state).toBe("MIXED_KNOWN_VALUES")
    expect(summaries[0]!.current_match!.matcher_version).toBe(MATCHER_VERSION)
  })

  it("clips snippets to 512 chars", () => {
    const long = "Acme Enterprise Platform ".repeat(100)
    const snap: AuthoritySnapshot = {
      lineages: [
        { rootId: "r", activeId: "f1", activeVersion: 1, valueType: "TEXT", currentValue: "Acme Enterprise Platform", historicalValues: [] },
      ],
    }
    const events = matchPage(`<html><body><p>${long}</p></body></html>`, snap)
    for (const e of events) expect(e.snippet.length).toBeLessThanOrEqual(512)
  })
})
