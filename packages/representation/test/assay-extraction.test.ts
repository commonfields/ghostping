import { describe, expect, it } from "vitest"
import { compareBooleanCapabilityClaim, comparePlanAvailabilityClaim, extractAssayJudgment, proposeAssayFacts, retrievalClassification } from "../src/assay-extraction.js"
import { parseMoneyFact } from "../src/assay.js"
const yes = { value: true, qualifier: "EXACT" } as const
const input = { subject: "Northstar", planTerms: ["Pro"], capabilityTerms: ["Salesforce"] }
describe("deterministic assay extraction", () => {
  it("proposes exactly three supported types with source spans and normalized price", () => {
    const result = proposeAssayFacts('<p>Northstar costs $79/month.</p><p>Northstar Pro plan is available.</p><p>Northstar supports Salesforce.</p><script>$49/month</script>', input)
    expect(result.facts.map(f => f.factType)).toEqual(["PRICE", "PLAN_AVAILABILITY", "BOOLEAN_CAPABILITY"])
    expect(result.facts[0]!.normalized).toMatchObject({ amountMinor: 7900, billingPeriod: "MONTH" })
    for (const fact of result.facts) expect(result.text).toContain(fact.supportingSpan)
  })
  it("does not assign a multi-price table or uncertain features", () => {
    expect(proposeAssayFacts('<p>Basic $49/month; Pro $79/month.</p><p>May support Salesforce.</p><p>Pro plan coming soon.</p>', input).facts).toEqual([])
    expect(proposeAssayFacts('<p>Northstar: $79.</p>', input).facts[0]!.normalized).toMatchObject({ qualifier: "UNKNOWN" })
  })
  it("preserves decimal price spans and ignores a bare number", () => {
    expect(proposeAssayFacts('<p>Northstar costs $79.99/month.</p>', input).facts[0]!.normalized).toMatchObject({ amountMinor: 7999 })
    expect(proposeAssayFacts('<p>Northstar is 79 years old.</p>', input).facts).toEqual([])
  })
  it.each([
    ["Northstar Pro plan is available.", "MATCHES"], ["Northstar Pro plan is not available.", "CONTRADICTS"],
    ["Pro plan may be available.", "UNCLEAR"], ["Pro is a great plan.", "UNCLEAR"],
    ["Basic plan is available.", "NOT_MENTIONED"], ["Northstar Pro plan is available. Pro is discontinued.", "UNCLEAR"],
  ])("compares plan availability: %s", (answer, expected) => expect(comparePlanAvailabilityClaim(yes, "Pro", answer, ["Northstar"])).toBe(expected))
  it.each([
    ["Northstar supports Salesforce.", "MATCHES"], ["Northstar does not support Salesforce.", "CONTRADICTS"],
    ["Northstar Salesforce integration is unavailable.", "CONTRADICTS"], ["Northstar might support Salesforce.", "UNCLEAR"],
    ["Salesforce is useful.", "UNCLEAR"], ["Northstar supports HubSpot.", "NOT_MENTIONED"],
    ["Northstar supports Salesforce. It does not support Salesforce.", "UNCLEAR"],
  ])("compares capability: %s", (answer, expected) => expect(compareBooleanCapabilityClaim(yes, "Salesforce", answer, ["Northstar"])).toBe(expected))
  it("keeps exact answer substrings and treats unresolved pricing as unclear", () => {
    const fact = { factType: "PRICE", subject: "Northstar", normalized: parseMoneyFact("$79 flat per month")! } as const
    for (const answer of ["Northstar costs $49 flat per month.", "Northstar costs $49/year.", "Northstar may cost $49/month.", "Northstar does not cost $49/month.", "Northstar costs $49/month billed annually.", "Other costs $49 flat per month.", "Northstar costs $49/month or $79/month.", "No price given."]) {
      const j = extractAssayJudgment(fact, answer)
      expect(answer.includes(j.supportingSpan)).toBe(true)
      expect(j.comparison).toBe(answer === "Northstar costs $49 flat per month." ? "CONTRADICTS" : answer === "No price given." ? "NOT_MENTIONED" : "UNCLEAR")
    }
  })
  it("only eligible provider-reported retrieval modes permit verification", () => {
    expect(retrievalClassification(["NONE", "parametric"])).toEqual({ retrievalClass: "STALE_PARAMETRIC_KNOWLEDGE", verificationEligible: false })
    for (const mode of ["unknown", "MANUAL_CAPTURE"]) expect(retrievalClassification([mode]).verificationEligible).toBe(false)
    for (const mode of ["grounded", "WEB_SEARCH", "PROVIDER_GROUNDING"]) expect(retrievalClassification([mode]).verificationEligible).toBe(true)
    expect(retrievalClassification(["WEB_SEARCH", "NONE"]).verificationEligible).toBe(false)
  })
})

describe("natural plan-price answers", () => {
  const normalized = { amountMinor: 7900, currency: "USD", billingPeriod: "MONTH", unit: "UNSTATED", qualifier: "EXACT" } as const
  const judge = (a: string) => extractAssayJudgment({ factType: "PRICE", subject: "Pro", normalized, businessAliases: ["Acme"] }, a).comparison
  it("judges a plain monthly price that names the business", () => {
    expect(judge("Acme's Pro plan costs $49/month.")).toBe("CONTRADICTS")
    expect(judge("Acme's Pro plan costs $79/month.")).toBe("MATCHES")
  })
  it("does not credit generic or other-company plan statements to the prospect", () => {
    expect(judge("Pro plans typically cost $99/month.")).toBe("UNCLEAR")
    expect(judge("The Pro plan costs $49/month.")).toBe("UNCLEAR")
    expect(judge("Basecamp Pro costs $99/month.")).toBe("UNCLEAR")
    expect(judge("Acme's Pro plan costs $49 per user per month.")).toBe("UNCLEAR")
  })
})
