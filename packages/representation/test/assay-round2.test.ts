import { describe, expect, it } from "vitest"
import { compareMoneyClaim, findMoneyVariant, moneyVariants, parseMoneyFact } from "../src/assay.js"
import { extractAssayJudgment, proposeAssayFacts, retrievalClassification } from "../src/assay-extraction.js"
const price = { factType: "PRICE", subject: "Acme", businessAliases: ["Acme"], planTerms: ["Enterprise", "Pro"], normalized: { amountMinor: 4900, currency: "USD", billingPeriod: "MONTH", unit: "ACCOUNT", qualifier: "EXACT" } } as const
const capability = { factType: "BOOLEAN_CAPABILITY", subject: "Slack", businessAliases: ["Acme"], normalized: { value: false, qualifier: "EXACT" } } as const
const input = { subject: "Acme", planTerms: ["Pro"], capabilityTerms: ["Slack"] }
describe("assay round 2 adversarial regressions", () => {
  it.each([
    "Basecamp integrates with Slack, while Acme does not.", "Acme no longer integrates with Slack.",
    "Unlike Acme, Basecamp integrates with Slack.", "Basecamp integrates with Slack.",
    "Acme supports Slack in Europe.", "Acme previously supported Slack.", "Acme supports Slack for enterprise.",
    "Acme supports Slack in 2027.", "Acme supports Slack alongside Basecamp.",
  ])("B1 rejects other entity, temporal or scoped capability: %s", answer => {
    expect(extractAssayJudgment(capability, answer).comparison).toBe("UNCLEAR")
    expect(extractAssayJudgment({ ...capability, normalized: { value: true, qualifier: "EXACT" } }, answer).comparison).toBe("UNCLEAR")
    expect(proposeAssayFacts(`<p>${answer}</p>`, input).facts.filter(f => f.factType === "BOOLEAN_CAPABILITY")).toEqual([])
  })
  it.each(["Basecamp Pro is available, while Acme has no Pro tier.", "Acme Pro is not available in Europe, but it is available in the US.", "Pro is available."])("B1 rejects scoped or business-free plan: %s", answer => {
    const fact = { factType: "PLAN_AVAILABILITY", subject: "Pro", businessAliases: ["Acme"], normalized: { value: false, qualifier: "EXACT" } } as const
    expect(extractAssayJudgment(fact, answer).comparison).toBe("UNCLEAR")
    expect(proposeAssayFacts(`<p>${answer}</p>`, input).facts.filter(f => f.factType === "PLAN_AVAILABILITY")).toEqual([])
  })
  it("B1 all-correct 3 contrast plus 2 negative samples produce zero contradictions", () => {
    const answers = [...Array<string>(3).fill("Basecamp integrates with Slack, while Acme does not."), ...Array<string>(2).fill("Acme does not integrate with Slack.")]
    expect(answers.map(a => extractAssayJudgment(capability, a).comparison)).toEqual(["UNCLEAR", "UNCLEAR", "UNCLEAR", "MATCHES", "MATCHES"])
  })
  it.each([
    "Acme starts at $29 per month.", "Acme begins at $29 per month.", "Acme from $29 per month.",
    "Acme costs $39 per month, billed yearly.", "Acme costs $39 per month, billed annually.",
    `Acme costs $39 flat per month ${"with additional information ".repeat(5)} billed annually.`,
    "Acme costs $15 per agent per month.", "Acme costs $10 per active user per month.", "Acme costs $10 per month for each user.",
    "Acme costs $29 per month.", "Acme costs A$79 per month.", "Acme costs CA$65 per month.", "Acme costs US$49 per month.",
    "Acme costs $4.9k per month.", "Acme costs $49K per month.", "Acme costs €1.299,00 per month.",
    "In 2019, Acme cost $29 flat per month.", "Acme was $29 flat per month.",
    "Acme is cheaper than Basecamp, which costs $99 flat per month.", "Acme's Enterprise plan costs $199 flat per month.",
    "Acme has a deal for $29 flat per month.", "Acme sale $29 flat per month.", "Acme costs $29 flat per month, 50% off.", "Acme Black Friday price is $29 flat per month.",
  ])("B2 incomparable price stays UNCLEAR: %s", answer => expect(extractAssayJudgment(price, answer).comparison).toBe("UNCLEAR"))
  it("B2 never treats API as a currency and accepts only explicit identical units", () => {
    expect(parseMoneyFact("500 API calls for $49")).toMatchObject({ currency: "USD", amountMinor: 4900 })
    expect(parseMoneyFact("500 API calls")).toBeNull()
    expect(compareMoneyClaim(price.normalized, "Acme costs $29 flat per month.")).toBe("CONTRADICTS")
    expect(compareMoneyClaim({ ...price.normalized, unit: "UNKNOWN" }, "Acme costs $29 per month.")).toBe("UNCLEAR")
    expect(parseMoneyFact("CAD 65 per account per month")).toMatchObject({ currency: "CAD", unit: "ACCOUNT" })
    for (const text of ["A$79", "CA$65", "US$49", "$4.9k", "$49K", "€1.299,00"]) expect(parseMoneyFact(text)).toBeNull()
  })
  it("B2 plan-scoped proposals use the smallest card and never join sibling blocks", () => {
    const result = proposeAssayFacts('<section><article><h2>Pro</h2><p>$49 flat per month</p></article><article><h2>Enterprise</h2><p>Starting at $199 per seat monthly</p></article></section>', { ...input, planTerms: ["Pro", "Enterprise"] })
    expect(result.facts.map(f => [f.subject, f.factType, f.normalized])).toEqual([
      ["Pro", "PRICE", { ...price.normalized }],
      ["Enterprise", "PRICE", { amountMinor: 19900, currency: "USD", unit: "SEAT", billingPeriod: "MONTH", qualifier: "STARTING_AT" }],
    ])
    for (const fact of result.facts) expect(result.text).toContain(fact.supportingSpan)
    expect(proposeAssayFacts('<section><h2>Pro</h2></section><section>$49 monthly</section>', input).facts).toEqual([])
    expect(proposeAssayFacts('<article>Pro $49 monthly billed yearly</article><article>Enterprise $199 monthly</article>', { ...input, planTerms: ["Pro", "Enterprise"] }).facts[0]!.normalized).toMatchObject({ qualifier: "UNKNOWN" })
  })
  it("M1 a synthetic judged sample overrides reported retrieval", () => {
    expect(retrievalClassification(["WEB_SEARCH"], true)).toEqual({ retrievalClass: "SYNTHETIC_FIXTURE", verificationEligible: false })
  })
  it("M5 200k-digit page and 30k-digit answer finish under 500ms", () => {
    const started = performance.now()
    expect(proposeAssayFacts(`<p>Acme $${"9".repeat(200_000)}</p>`, input).facts).toEqual([])
    expect(extractAssayJudgment(price, `Acme $${"9".repeat(30_000)}`).comparison).toBe("UNCLEAR")
    expect(performance.now() - started).toBeLessThan(500)
  })
  it("M5 bounded parser microbenchmark stays below a generous 750ms cap", () => {
    const started = performance.now()
    for (let i = 0; i < 1000; i++) {
      expect(parseMoneyFact(`$${"9".repeat(1900)} per month`)).toBeNull()
      expect(parseMoneyFact(`${"9".repeat(1900)} API`)).toBeNull()
    }
    expect(performance.now() - started).toBeLessThan(750)
  })
  // Each answer differs from the confirmed $49 flat/month/EXACT fact in exactly
  // one dimension, so UNCLEAR is caused by that dimension and nothing else.
  it.each([
    "Acme starts at $29 flat per month.", "Acme begins at $29 flat per month.", "Acme is from $29 flat per month.",
    "Acme costs $29 flat per month, billed annually.", "Acme costs $29 flat per month, billed yearly.",
    "Acme costs $29 per user per month.", "Acme costs $29 per agent per month.",
    "Acme costs US$29 flat per month.", "Acme costs A$29 flat per month.", "Acme costs €29 flat per month.",
    "Acme costs $49K flat per month.", "Acme costs $4.9k flat per month.", "Acme costs €1.299,00 flat per month.",
    "In 2019, Acme cost $29 flat per month.", "Acme was $29 flat per month.", "Acme has a Black Friday deal at $29 flat per month.",
    "Acme's Enterprise plan costs $29 flat per month.", "Acme is cheaper than Basecamp, which costs $29 flat per month.",
  ])("B2 one differing dimension is UNCLEAR, never CONTRADICTS: %s", answer => {
    expect(extractAssayJudgment(price, answer).comparison).toBe("UNCLEAR")
  })
  it("B2 controls: same basis matches or contradicts; k-suffix never matches", () => {
    expect(extractAssayJudgment(price, "Acme costs $49 flat per month.").comparison).toBe("MATCHES")
    expect(extractAssayJudgment(price, "Acme costs $29 flat per month.").comparison).toBe("CONTRADICTS")
    expect(extractAssayJudgment(price, "Acme costs $49k flat per month.").comparison).toBe("UNCLEAR")
    expect(extractAssayJudgment(price, "Nothing about cost here.").comparison).toBe("NOT_MENTIONED")
    expect(parseMoneyFact("It costs $79.")).toMatchObject({ amountMinor: 7900, currency: "USD" })
  })
  it("B1 common sentence openers are not treated as another organisation", () => {
    expect(extractAssayJudgment(capability, "Yes, Acme does not integrate with Slack.").comparison).toBe("MATCHES")
    expect(extractAssayJudgment(capability, "Currently Acme supports Slack.").comparison).toBe("CONTRADICTS")
    expect(extractAssayJudgment(capability, "Yes, Basecamp supports Slack.").comparison).toBe("UNCLEAR")
  })
  it("LIKELY_SOURCE variants match whole amounts only", () => {
    expect(moneyVariants({ amountMinor: 4950, currency: "USD" })).toEqual(["$49.50", "49.50/mo", "$49.50/month", "$49.50 per month"])
    expect(moneyVariants({ amountMinor: 4900, currency: "CAD" })).toEqual(["49 CAD"])
    for (const text of ["Now $49,000 per year.", "Only $49k.", "Pro is $149.", "Pro is $49.50.", "Pro is US$49.", "Pro is 149/mo."]) {
      for (const variant of moneyVariants({ amountMinor: 4900, currency: "USD" })) expect(findMoneyVariant(text, variant), `${variant} in ${text}`).toBe(-1)
    }
    expect(findMoneyVariant("Old page: Pro is $49.", "$49")).toBe(17)
    expect(findMoneyVariant("Pro $49/mo today", "49/mo")).toBe(5)
    expect(findMoneyVariant("Pro is $49.50 monthly.", "$49.50")).toBe(7)
  })
  it("plan cards with ordinary feature lists still yield a price; doubt degrades to UNKNOWN", () => {
    const cards = '<div class="grid"><div class="card"><h3>Pro</h3><p>$49 flat per month</p><ul><li>Unlimited projects</li><li>Gantt charts</li><li>Slack integration</li></ul></div>' +
      '<div class="card"><h3>Enterprise</h3><p>$199 flat per month</p><p>Billed annually</p><ul><li>SAML SSO</li></ul></div></div>'
    const result = proposeAssayFacts(cards, { ...input, planTerms: ["Pro", "Enterprise"] })
    expect(result.facts.find(f => f.subject === "Pro")?.normalized).toEqual(price.normalized)
    expect(result.facts.find(f => f.subject === "Enterprise")?.normalized).toMatchObject({ amountMinor: 19900, qualifier: "UNKNOWN" })
    for (const fact of result.facts) expect(result.text).toContain(fact.supportingSpan)
    const imports = proposeAssayFacts('<div><h3>Pro</h3><p>$49 flat per month</p><p>Import from Trello</p></div>', input)
    expect(imports.facts[0]!.normalized).toMatchObject({ qualifier: "UNKNOWN" })
  })
  it("M5 deeply nested page finishes quickly without stack overflow", () => {
    const started = performance.now()
    const html = `<body>${"<div>".repeat(60_000)}Pro $49 flat per month${"</div>".repeat(60_000)}</body>`
    const result = proposeAssayFacts(html, input)
    expect(result.facts).toEqual([])
    expect(result.text).toBe("Pro $49 flat per month")
    expect(proposeAssayFacts(`<body>${"<a".repeat(300_000)}</body>`, input).facts).toEqual([])
    expect(performance.now() - started).toBeLessThan(1000)
    // Ordinary nesting below the bound is still parsed.
    expect(proposeAssayFacts(`<body>${"<div>".repeat(200)}<p>Acme costs $49 flat per month.</p>${"</div>".repeat(200)}</body>`, input).facts).toHaveLength(1)
  })
})
