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
    ["starter-price", { key: "starter-price", value: { type: "money", amount: "49.00", currency: "USD" }, ref: { kind: "AUTHORITATIVE_FACT", key: "starter-price", fact_id: "fact-1", version: 1, manifest_digest: "d" } }],
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
    expect(a.source_refs).toEqual([{ kind: "AUTHORITATIVE_FACT", key: "starter-price", fact_id: "fact-1", version: 1, manifest_digest: "d" }])
    expect(a.canonical_bytes).not.toMatch(/2026|fact-1/)
  })

  it("resolves text and boolean references", () => {
    const m = parseManifest(VALID_MANIFEST_TEXT)
    const facts = new Map<string, ResolvedFact>([
      ["tagline", { key: "tagline", value: { type: "text", value: "Hi" }, ref: { kind: "MANIFEST_FACT", key: "tagline", manifest_digest: "d" } }],
      ["salesforce-supported", { key: "salesforce-supported", value: { type: "boolean", value: false }, ref: { kind: "MANIFEST_FACT", key: "salesforce-supported", manifest_digest: "d" } }],
      ["starter-price", { key: "starter-price", value: { type: "money", amount: "49.00", currency: "USD" }, ref: { kind: "MANIFEST_FACT", key: "starter-price", manifest_digest: "d" } }],
    ])
    const a = compileProjection(m, "starter-offer", facts)
    expect(a.canonical_bytes).toContain('"price":"49.00"')
    expect(a.source_refs).toEqual([{ kind: "MANIFEST_FACT", key: "starter-price", manifest_digest: "d" }])
  })

  it("rejects dangling refs and wrong components at compile time", () => {
    const m = parseManifest(VALID_MANIFEST_TEXT)
    expect(() => compileProjection(m, "nope", resolved)).toThrowError(/UnknownProjection/)
    expect(() =>
      compileProjection(m, "starter-offer", new Map([["starter-price", { key: "starter-price", value: { type: "text", value: "x" }, ref: { kind: "MANIFEST_FACT", key: "starter-price", manifest_digest: "d" } }]])),
    ).toThrowError(/ComponentTypeMismatch/)
  })
})

describe("provenance honesty", () => {
  const offline = (key: string): ResolvedFact => ({
    key,
    value: { type: "money", amount: "49.00", currency: "USD" },
    ref: { kind: "MANIFEST_FACT", key, manifest_digest: "digest-x" },
  })

  it("A. offline compile carries MANIFEST provenance only, no fake UUID/version", () => {
    const m = parseManifest(VALID_MANIFEST_TEXT)
    const a = compileProjection(m, "starter-offer", new Map([["starter-price", offline("starter-price")]]))
    expect(a.source_refs).toEqual([{ kind: "MANIFEST_FACT", key: "starter-price", manifest_digest: "digest-x" }])
    expect(a.source_refs[0]).not.toHaveProperty("fact_id")
    expect(a.source_refs[0]).not.toHaveProperty("version")
  })

  it("B. synced compile carries real fact UUID/version", () => {
    const m = parseManifest(VALID_MANIFEST_TEXT)
    const a = compileProjection(
      m,
      "starter-offer",
      new Map([["starter-price", { key: "starter-price", value: { type: "money", amount: "49.00", currency: "USD" }, ref: { kind: "AUTHORITATIVE_FACT", key: "starter-price", fact_id: "11111111-2222-3333-4444-555555555555", version: 2, manifest_digest: m.digest } }]]),
    )
    expect(a.source_refs).toEqual([
      { kind: "AUTHORITATIVE_FACT", key: "starter-price", fact_id: "11111111-2222-3333-4444-555555555555", version: 2, manifest_digest: m.digest },
    ])
  })

  it("D. projection bytes do not depend on DB UUIDs", () => {
    const m = parseManifest(VALID_MANIFEST_TEXT)
    const withUuidA = compileProjection(
      m,
      "starter-offer",
      new Map([["starter-price", { key: "starter-price", value: { type: "money", amount: "49.00", currency: "USD" }, ref: { kind: "AUTHORITATIVE_FACT", key: "starter-price", fact_id: "aaaaaaaa-0000-0000-0000-000000000000", version: 1, manifest_digest: m.digest } }]]),
    )
    const withUuidB = compileProjection(
      m,
      "starter-offer",
      new Map([["starter-price", { key: "starter-price", value: { type: "money", amount: "49.00", currency: "USD" }, ref: { kind: "AUTHORITATIVE_FACT", key: "starter-price", fact_id: "bbbbbbbb-0000-0000-0000-000000000000", version: 7, manifest_digest: m.digest } }]]),
    )
    expect(withUuidA.canonical_bytes).toBe(withUuidB.canonical_bytes)
    expect(withUuidA.digest_sha256).toBe(withUuidB.digest_sha256)
  })

  it("E. no synthetic manifest fact_id masquerade remains", () => {
    const m = parseManifest(VALID_MANIFEST_TEXT)
    const a = compileProjection(m, "starter-offer", new Map([["starter-price", offline("starter-price")]]))
    expect(JSON.stringify(a)).not.toMatch(/manifest:starter-price/)
  })
})
