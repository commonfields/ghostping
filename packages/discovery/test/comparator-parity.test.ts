// Cross-package contract: discovery matcher reuses @ghostping/representation
// comparator/parser primitives (parseMoney, parseBoolean, normalizeExactText,
// compareMoney). These tests import BOTH sides and assert the same
// interpretation: compareMoney IN_SYNC ⟺ discovery structured match,
// parseBoolean tokens ⟺ discovery BOOLEAN match, normalizeExactText+trim
// ⟺ discovery TEXT match. Discovery-specific behavior (surfaces, snippet
// bounds, CURRENT/HISTORICAL mapping, MIN_VISIBLE_TEXT_LENGTH) is untouched.

import { describe, expect, it } from "vitest"
import { compareMoney, normalizeExactText, parseBoolean, parseMoney } from "@ghostping/representation"
import { matchPage, type AuthoritySnapshot } from "../src/matcher.js"

const moneySnap = (current: string): AuthoritySnapshot => ({
  lineages: [{ rootId: "root-price", activeId: "fact-v2", activeVersion: 2, valueType: "CURRENCY", currentValue: current, historicalValues: [] }],
})

const boolSnap = (current: string): AuthoritySnapshot => ({
  lineages: [{ rootId: "root-b", activeId: "f1", activeVersion: 1, valueType: "BOOLEAN", currentValue: current, historicalValues: [] }],
})

const textSnap = (current: string): AuthoritySnapshot => ({
  lineages: [{ rootId: "root-t", activeId: "f1", activeVersion: 1, valueType: "TEXT", currentValue: current, historicalValues: [] }],
})

const metaHtml = (content: string): string =>
  `<html><head><meta name="x" content="${content}"></head><body></body></html>`

const jsonLdHtml = (obj: unknown): string =>
  `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`

const hasStructuredMatch = (html: string, snap: AuthoritySnapshot): boolean =>
  matchPage(html, snap).some((e) => e.surface === "META" || e.surface === "JSON_LD")

describe("comparator parity (discovery ⟺ representation)", () => {
  it("money: $49 vs 49 USD is IN_SYNC-equivalent", () => {
    expect(parseMoney("$49")).toEqual(parseMoney("49 USD"))
    expect(compareMoney("49 USD", "$49")).toBe("IN_SYNC")
    expect(hasStructuredMatch(metaHtml("$49"), moneySnap("49 USD"))).toBe(true)
    expect(hasStructuredMatch(metaHtml("$49.00"), moneySnap("49 USD"))).toBe(true)
  })

  it("money: currency mismatch is DRIFT and never matches", () => {
    expect(compareMoney("49 USD", "49 EUR")).toBe("DRIFT")
    expect(compareMoney("$49", "€49")).toBe("DRIFT")
    expect(hasStructuredMatch(metaHtml("49 EUR"), moneySnap("49 USD"))).toBe(false)
    expect(hasStructuredMatch(metaHtml("€49"), moneySnap("49 USD"))).toBe(false)
  })

  it("money: unknown currency / unparsable is UNKNOWN and never matches", () => {
    expect(parseMoney("49")?.currency).toBeNull()
    expect(parseMoney("hello")).toBeNull()
    expect(compareMoney("49 USD", "49")).toBe("UNKNOWN")
    expect(compareMoney("49 USD", "hello")).toBe("UNKNOWN")
    expect(hasStructuredMatch(metaHtml("49"), moneySnap("49 USD"))).toBe(false)
    expect(hasStructuredMatch(metaHtml("hello"), moneySnap("49 USD"))).toBe(false)
  })

  it("money: JPY uses 0 decimals, others use 2", () => {
    expect(parseMoney("1000 JPY")).toEqual({ amountMinor: 1000, currency: "JPY" })
    expect(parseMoney("¥1000")).toEqual({ amountMinor: 1000, currency: "JPY" })
    expect(parseMoney("49.99 USD")?.amountMinor).toBe(4999)
    // 0-decimal rounding is JPY-specific: 1000.6 JPY rounds to 1001 JPY.
    expect(parseMoney("1000.6 JPY")?.amountMinor).toBe(1001)
    expect(compareMoney("1001 JPY", "1000.6 JPY")).toBe("IN_SYNC")
    expect(hasStructuredMatch(metaHtml("¥1000"), moneySnap("1000 JPY"))).toBe(true)
    expect(hasStructuredMatch(metaHtml("1000.6 JPY"), moneySnap("1001 JPY"))).toBe(true)
  })

  it("boolean: shared TRUE tokens match structured, cross-polarity does not", () => {
    const trueTokens = ["true", "yes", "1", "on", "enabled"]
    for (const t of trueTokens) expect(parseBoolean(t)).toBe(true)
    expect(parseBoolean("YES")).toBe(true) // shared lowercases + trims
    for (const t of trueTokens) {
      expect(hasStructuredMatch(metaHtml(t), boolSnap("true"))).toBe(true)
    }
    // Cross-polarity: same-parse required on both sides.
    expect(parseBoolean("true")).not.toBe(parseBoolean("no"))
    expect(hasStructuredMatch(metaHtml("false"), boolSnap("true"))).toBe(false)
    expect(hasStructuredMatch(metaHtml("no"), boolSnap("true"))).toBe(false)
    expect(hasStructuredMatch(metaHtml("0"), boolSnap("true"))).toBe(false)
    expect(hasStructuredMatch(metaHtml("off"), boolSnap("true"))).toBe(false)
    expect(hasStructuredMatch(metaHtml("disabled"), boolSnap("true"))).toBe(false)
  })

  it("boolean: shared FALSE tokens match structured, unknown never matches", () => {
    const falseTokens = ["false", "no", "0", "off", "disabled"]
    for (const t of falseTokens) expect(parseBoolean(t)).toBe(false)
    for (const t of falseTokens) {
      expect(hasStructuredMatch(metaHtml(t), boolSnap("false"))).toBe(true)
    }
    expect(parseBoolean("maybe")).toBeNull()
    expect(hasStructuredMatch(metaHtml("maybe"), boolSnap("true"))).toBe(false)
    expect(hasStructuredMatch(metaHtml("maybe"), boolSnap("false"))).toBe(false)
  })

  it("text: NFC normalization identical to normalizeExactText", () => {
    const composed = "caf\u00e9"
    const decomposed = "cafe\u0301"
    expect(normalizeExactText(composed)).toBe(normalizeExactText(decomposed))
    expect(hasStructuredMatch(metaHtml(decomposed), textSnap(composed))).toBe(true)
  })

  it("text: CRLF/CR/LF whitespace identical to normalizeExactText (via JSON-LD)", () => {
    expect(normalizeExactText("a\r\nb")).toBe(normalizeExactText("a\nb"))
    expect(normalizeExactText("a\rb")).toBe(normalizeExactText("a\nb"))
    expect(hasStructuredMatch(jsonLdHtml({ name: "a\r\nb" }), textSnap("a\nb"))).toBe(true)
    expect(hasStructuredMatch(jsonLdHtml({ name: "a\rb" }), textSnap("a\nb"))).toBe(true)
  })

  it("text: discovery composes trim around normalizeExactText", () => {
    // Shared primitive alone does no trimming; discovery trims on top.
    expect(normalizeExactText("  hello  ")).not.toBe(normalizeExactText("hello"))
    expect(normalizeExactText("  hello  ").trim()).toBe(normalizeExactText("hello").trim())
    expect(hasStructuredMatch(metaHtml("hello"), textSnap("  hello  "))).toBe(true)
  })

  it("text: structured match agrees with normalizeExactText+trim for a table", () => {
    const pairs: Array<[authority: string, observed: string, useJsonLd: boolean]> = [
      ["Acme Cloud Suite", "Acme Cloud Suite", false],
      ["caf\u00e9", "cafe\u0301", false],
      ["a\nb", "a\r\nb", true],
      ["  padded  ", "padded", false],
      ["hello", "goodbye", false],
      ["Price Plans", "price plans", false], // no case folding on either side
    ]
    for (const [authority, observed, useJsonLd] of pairs) {
      const expected = normalizeExactText(authority).trim() === normalizeExactText(observed).trim()
      const html = useJsonLd ? jsonLdHtml({ name: observed }) : metaHtml(observed)
      expect(hasStructuredMatch(html, textSnap(authority))).toBe(expected)
    }
  })

  it("money table: compareMoney IN_SYNC ⟺ discovery structured match", () => {
    const pairs: Array<[authority: string, observed: string]> = [
      ["49 USD", "$49"],
      ["49 USD", "49 EUR"],
      ["49 USD", "49"],
      ["1000 JPY", "¥1000"],
      ["59.00 USD", "59 USD"],
    ]
    for (const [authority, observed] of pairs) {
      const expected = compareMoney(authority, observed) === "IN_SYNC"
      expect(hasStructuredMatch(metaHtml(observed), moneySnap(authority))).toBe(expected)
    }
  })
})
