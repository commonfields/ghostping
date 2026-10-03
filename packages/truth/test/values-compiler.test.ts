import { describe, expect, it } from "vitest"
import {
  canonicalAmount,
  compileProjection,
  decodeBridge,
  encodeBridge,
  parseManifest,
  sameValue,
  type ResolvedFact,
} from "../src/index.js"
import { VALID_MANIFEST_TEXT } from "./manifest-text.js"

describe("typed values", () => {
  it("canonicalizes decimal amounts without floats", () => {
    expect(canonicalAmount("49.00")).toBe("49.00")
    expect(canonicalAmount("049.00")).toBe("49.00")
    expect(canonicalAmount("+49")).toBe("49")
    expect(canonicalAmount("-0.00")).toBe("0.00")
    expect(canonicalAmount("0")).toBe("0")
    expect(() => canonicalAmount("4.9e1")).toThrowError(/InvalidMoney/)
    expect(() => canonicalAmount("")).toThrowError(/InvalidMoney/)
    expect(() => canonicalAmount(49 as unknown as string)).toThrowError(/InvalidMoney/)
  })

  it("bridges to AuthoritativeFact encoding and back", () => {
    expect(encodeBridge({ type: "text", value: "Hi" })).toEqual({ value_text: "Hi", value_type: "TEXT" })
    expect(encodeBridge({ type: "boolean", value: true })).toEqual({ value_text: "true", value_type: "BOOLEAN" })
    expect(encodeBridge({ type: "money", amount: "49.00", currency: "USD" })).toEqual({ value_text: "49.00 USD", value_type: "CURRENCY" })
    expect(decodeBridge("49.00 USD", "CURRENCY")).toEqual({ type: "money", amount: "49.00", currency: "USD" })
    expect(decodeBridge("true", "BOOLEAN")).toEqual({ type: "boolean", value: true })
    expect(decodeBridge("$39/month", "CURRENCY")).toBeNull()
    expect(sameValue({ type: "money", amount: "49.00", currency: "USD" }, { type: "money", amount: "49.00", currency: "USD" })).toBe(true)
    expect(sameValue({ type: "money", amount: "49.00", currency: "USD" }, { type: "money", amount: "49.0", currency: "USD" })).toBe(false)
  })
})

describe("compiler", () => {
  const resolved = new Map<string, ResolvedFact>([
    ["starter-price", { key: "starter-price", fact_id: "fact-1", version: 1, value: { type: "money", amount: "49.00", currency: "USD" } }],
  ])

  it("produces deterministic bytes and digests", () => {
    const m = parseManifest(VALID_MANIFEST_TEXT)
    const a = compileProjection(m, "starter-offer", resolved)
    const b = compileProjection(m, "starter-offer", resolved)
    expect(a.canonical_bytes).toBe(b.canonical_bytes)
    expect(a.digest_sha256).toBe(b.digest_sha256)
    expect(a.digest_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(a.canonical_bytes).toBe('{"@context":"https://schema.org","@type":"Offer","price":"49.00","priceCurrency":"USD"}')
    expect(a.media_type).toBe("application/ld+json")
    expect(a.compiler_version).toBe("truth-compiler/1")
    expect(a.source_fact_versions).toEqual([{ key: "starter-price", fact_id: "fact-1", version: 1 }])
    expect(a.canonical_bytes).not.toMatch(/2026|fact-1/)
  })

  it("resolves text and boolean references", () => {
    const m = parseManifest(VALID_MANIFEST_TEXT)
    const facts = new Map<string, ResolvedFact>([
      ["tagline", { key: "tagline", fact_id: "f-t", version: 1, value: { type: "text", value: "Hi" } }],
      ["salesforce-supported", { key: "salesforce-supported", fact_id: "f-b", version: 2, value: { type: "boolean", value: false } }],
      ["starter-price", { key: "starter-price", fact_id: "f-m", version: 1, value: { type: "money", amount: "49.00", currency: "USD" } }],
    ])
    const a = compileProjection(m, "starter-offer", facts)
    expect(a.canonical_bytes).toContain('"price":"49.00"')
  })

  it("rejects dangling refs and wrong components at compile time", () => {
    const m = parseManifest(VALID_MANIFEST_TEXT)
    expect(() => compileProjection(m, "nope", resolved)).toThrowError(/UnknownProjection/)
    expect(() =>
      compileProjection(m, "starter-offer", new Map([["starter-price", { key: "starter-price", fact_id: "f", version: 1, value: { type: "text", value: "x" } }]])),
    ).toThrowError(/ComponentTypeMismatch/)
  })
})
