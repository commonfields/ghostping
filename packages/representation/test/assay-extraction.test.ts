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

describe("orchestrator attack round: stated bases, negations, hedges and trials are never contradictions", () => {
  const normalized = { amountMinor: 7900, currency: "USD", billingPeriod: "MONTH", unit: "UNSTATED", qualifier: "EXACT" } as const
  const judge = (a: string) => extractAssayJudgment({ factType: "PRICE", subject: "Pro", normalized, businessAliases: ["Acme"] }, a).comparison
  it.each([
    "Acme's Pro plan costs $49 per month for 5 users.",
    "Acme's Pro plan costs $49 per 1,000 contacts per month.",
    "Acme's Pro plan costs $49 monthly for the whole team.",
    "Acme's Pro plan costs $49/month for a team.",
    "Acme's Pro plan costs $49/month after a free trial.",
    "Acme's Pro plan is free, then $49/month.",
    "Acme's Pro plan doesn't cost $49/month.",
    "Acme's Pro plan isn't $49/month.",
    "Acme's Pro plan costs roughly $49/month.",
    "Acme's Pro plan typically costs $49/month.",
    "Acme's Pro plan will cost $49/month.",
  ])("UNCLEAR: %s", a => expect(judge(a)).toBe("UNCLEAR"))
  it.each([
    ["Acme's Pro plan costs $49 a month.", "CONTRADICTS"],
    ["Acme's Pro plan costs $79 a month.", "MATCHES"],
    ["Acme's Pro plan costs $49 each month.", "CONTRADICTS"],
    ["Acme's Pro plan costs $49/month and includes unlimited projects.", "CONTRADICTS"],
    ["Acme's Pro plan costs $49 a month per head.", "UNCLEAR"],
  ] as const)("natural phrasing stays comparable: %s", (a, v) => expect(judge(a)).toBe(v))
})

describe("pricing cards keep their ordinary trial wording", () => {
  it("a '14-day free trial' line does not make the card price uncertain", () => {
    const html = `<div><div><h3>Pro</h3><p>$79/month</p><p>14-day free trial</p></div><div><h3>Team</h3><p>$149/month</p></div></div>`
    const f = proposeAssayFacts(html, { subject: "Acme", planTerms: ["Pro", "Team"], capabilityTerms: [] }).facts.find(x => x.subject === "Pro")
    expect(f && (f.normalized as { qualifier: string }).qualifier).toBe("EXACT")
  })
})

describe("independent review round: capability denials, questions, near-miss nouns and segment prices", () => {
  const cap = (value: boolean, a: string) => extractAssayJudgment({ factType: "BOOLEAN_CAPABILITY", subject: "Slack", normalized: { value, qualifier: "EXACT" }, businessAliases: ["Acme"] }, a).comparison
  it.each([
    "Acme does not currently support Slack.", "Acme does not natively support Slack.", "Acme does not directly support Slack.",
    "Acme does not fully support Slack.", "Acme does not yet support Slack.", "Acme does not really support Slack.", "Acme cannot currently support Slack.",
  ])("adverb-interrupted denial is a denial: %s", a => {
    expect(cap(false, a)).toBe("MATCHES")
    expect(cap(true, a)).toBe("CONTRADICTS")
  })
  it.each([
    "Acme does not appear to support Slack.", "Acme won't support Slack.", "does acme support slack?", "can acme support slack?",
    "I wonder whether Acme supports Slack.", "Whether Acme supports Slack is unclear to me.", "Acme supports Slack? Not really.",
    "Acme supports Slack-like integrations.", "Acme no longer supports Slack.",
  ])("questions, hedges and near-miss nouns are never a verdict: %s", a => {
    expect(cap(false, a)).toBe("UNCLEAR")
    expect(cap(true, a)).toBe("UNCLEAR")
  })
  it("a plain affirmation and denial still decide", () => {
    expect(cap(true, "Acme supports Slack.")).toBe("MATCHES")
    expect(cap(false, "Acme supports Slack.")).toBe("CONTRADICTS")
    expect(cap(false, "Acme does not support Slack.")).toBe("MATCHES")
  })
  const normalized = { amountMinor: 7900, currency: "USD", billingPeriod: "MONTH", unit: "UNSTATED", qualifier: "EXACT" } as const
  const price = (a: string) => extractAssayJudgment({ factType: "PRICE", subject: "Pro", normalized, businessAliases: ["Acme"] }, a).comparison
  it("segment-qualified prices are not the plan price", () => {
    expect(price("Acme's Pro plan costs $79/month for students.")).toBe("UNCLEAR")
    expect(price("Acme's Pro plan costs $79/month for nonprofits.")).toBe("UNCLEAR")
    const html = `<div><div><h3>Pro</h3><p>$79/month for students</p></div><div><h3>Team</h3><p>$149/month</p></div></div>`
    const proposed = proposeAssayFacts(html, { subject: "Acme", planTerms: ["Pro", "Team"], capabilityTerms: [] }).facts.find(f => f.subject === "Pro")
    expect(proposed && (proposed.normalized as { unit: string }).unit).not.toBe("UNSTATED")
  })
  it("'$79 / month' keeps its period", () => {
    expect(price("Acme's Pro plan costs $79 / month.")).toBe("MATCHES")
    expect(price("Acme's Pro plan costs $49 / month.")).toBe("CONTRADICTS")
  })
})
