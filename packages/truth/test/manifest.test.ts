import { describe, expect, it } from "vitest"
import { parseManifest, TRUTH_MANIFEST_SCHEMA } from "../src/index.js"
import { VALID_MANIFEST_TEXT } from "./manifest-text.js"

const VALID = VALID_MANIFEST_TEXT

describe("manifest", () => {
  it("accepts a valid manifest with a stable digest", () => {
    const a = parseManifest(VALID)
    const b = parseManifest(VALID)
    expect(a.schema).toBe(TRUTH_MANIFEST_SCHEMA)
    expect(a.business_key).toBe("acme")
    expect(a.facts.map((f) => f.key).sort()).toEqual(["salesforce-supported", "starter-price", "tagline"])
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(a.digest).toBe(b.digest)
  })

  it("rejects unknown schema", () => {
    expect(() => parseManifest(VALID.replace("openrecord/truth-manifest-v1", "openrecord/truth-manifest-v2"))).toThrowError(
      /UnknownSchema/,
    )
  })

  it("rejects unknown fields (typos fail closed)", () => {
    expect(() => parseManifest(VALID.replace("predicate: price", "predicat: price"))).toThrowError(/UnknownField/)
    expect(() => parseManifest(`${VALID}extra: 1\n`)).toThrowError(/UnknownField/)
  })

  it("rejects duplicate keys", () => {
    const dup = VALID.replace(
      "  salesforce-supported:",
      `  starter-price:
    subject: dup
    predicate: dup
    type: text
    value: dup
    valid_from: 2026-10-03T00:00:00Z
  salesforce-supported:`,
    )
    expect(() => parseManifest(dup)).toThrowError(/unique|duplicate/i)
  })

  it("rejects dangling fact references", () => {
    expect(() => parseManifest(VALID.replace("fact: starter-price", "fact: missing-price"))).toThrowError(
      /DanglingFactReference/,
    )
  })

  it("rejects invalid types, timestamps, money", () => {
    expect(() => parseManifest(VALID.replace("type: money", "type: json"))).toThrowError(/InvalidFactType/)
    expect(() => parseManifest(VALID.replace("2026-10-03T00:00:00Z", "next friday"))).toThrowError(/MalformedTimestamp/)
    expect(() => parseManifest(VALID.replace('amount: "49.00"', 'amount: "49"'))).not.toThrow()
    const m = parseManifest(VALID.replace('amount: "49.00"', 'amount: "49"'))
    expect(m.facts[0]!.value).toMatchObject({ type: "money", amount: "49", currency: "USD" })
    expect(() => parseManifest(VALID.replace('amount: "49.00"', "amount: 49"))).toThrowError(/InvalidMoney/)
    expect(() => parseManifest(VALID.replace("currency: USD", "currency: usd"))).toThrowError(/InvalidCurrency/)
  })

  it("rejects missing money currency", () => {
    expect(() => parseManifest(VALID.replace('      currency: USD\n', ""))).toThrowError(/InvalidMoney/)
  })

  it("rejects unsafe output paths", () => {
    expect(() => parseManifest(VALID.replace("output: public/generated/starter-offer.json", "output: ../evil.json"))).toThrowError(
      /UnsafeOutputPath/,
    )
    expect(() => parseManifest(VALID.replace("output: public/generated/starter-offer.json", "output: /abs/evil.json"))).toThrowError(
      /AbsoluteOutputPath/,
    )
    expect(() => parseManifest(VALID.replace("output: public/generated/starter-offer.json", "output: .git/hooks/x"))).toThrowError(
      /ReservedOutputPath/,
    )
  })

  it("rejects component/type mismatches", () => {
    // currency is a valid money component, so this variant still parses.
    expect(() => parseManifest(VALID.replace("component: amount", "component: currency"))).not.toThrow()
    const bad = VALID.replace("fact: starter-price\n        component: amount", "fact: salesforce-supported\n        component: amount")
    expect(() => parseManifest(bad)).toThrowError(/ComponentTypeMismatch/)
  })

  it("rejects interpolation, tags, aliases, and non-repository authority", () => {
    expect(() => parseManifest(VALID.replace("Pay per seat", "Pay ${seat} per seat"))).toThrowError(/InterpolationForbidden/)
    expect(() => parseManifest(`${VALID}  extra-tag: !Exec foo\n`)).toThrowError(/YamlTagForbidden|UnknownField/)
    expect(() => parseManifest(VALID.replace("mode: repository", "mode: hosted"))).toThrowError(/AuthorityModeMustBeRepository/)
    const aliased = VALID.replace("value: false", "value: &b false") + ""
    expect(() => parseManifest(aliased.replace("value: Pay per seat", "value: *b"))).toThrowError(/YamlAliasesForbidden|YamlAnchorsForbidden/)
  })

  it("rejects literal numbers in projection documents", () => {
    expect(() => parseManifest(VALID.replace('"@type": Offer', '"@type": Offer\n      version: 2'))).toThrowError(
      /LiteralNumberForbidden/,
    )
  })
})
