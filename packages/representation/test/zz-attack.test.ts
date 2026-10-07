import { describe, it } from "vitest"
import { compareMoneyClaim, parseMoneyFact } from "../src/assay.js"
import { extractAssayJudgment, proposeAssayFacts } from "../src/assay-extraction.js"

const priceFact = { factType: "PRICE", subject: "Pro", normalized: { amountMinor: 7900, currency: "USD", billingPeriod: "MONTH", unit: "UNSTATED", qualifier: "EXACT" }, businessAliases: ["Acme"], planTerms: ["Starter", "Pro", "Team"] } as const
const capTrue = { factType: "BOOLEAN_CAPABILITY", subject: "Slack", normalized: { value: true, qualifier: "EXACT" }, businessAliases: ["Acme"] } as const
const capFalse = { factType: "BOOLEAN_CAPABILITY", subject: "Slack", normalized: { value: false, qualifier: "EXACT" }, businessAliases: ["Acme"] } as const
const planTrue = { factType: "PLAN_AVAILABILITY", subject: "Pro", normalized: { value: true, qualifier: "EXACT" }, businessAliases: ["Acme"] } as const

const priceCases: string[] = [
  "Acme's Pro plan costs $79 a month per head.",
  "Acme Pro is $79/user/mo.",
  "Acme Pro costs $79 per team per month.",
  "Acme Pro costs $79/month for 5 users.",
  "Acme Pro costs $79 per 1,000 contacts per month.",
  "Acme Pro costs $79 monthly for the whole team.",
  "Acme Pro costs $79 per workspace per month.",
  "Acme Pro costs 79 dollars a month.",
  "Acme Pro costs $79 per person per month.",
  "Acme Pro costs $79 billed yearly.",
  "Acme Pro costs $948 a year ($79/month).",
  "Acme Pro costs $79/month paid annually.",
  "Acme Pro costs $79 each quarter.",
  "Acme Pro costs from $79 per month.",
  "Acme Pro costs starting at $79/month.",
  "Acme Pro costs as low as $79/month.",
  "Acme Pro costs up to $79/month.",
  "Acme Pro is free, then $79/month.",
  "Acme Pro has a free trial then $79/month.",
  "Acme Pro costs $79 introductory per month.",
  "Acme Pro regularly $99, now $79/month.",
  "Acme's Pro plan used to cost $79/month.",
  "Acme's Pro plan will cost $79/month from next year.",
  "Acme Pro costs $79/month in the US only.",
  "Acme's competitor Zoho Pro costs $79/month.",
  "acme pro costs $79/month.",
  "ACME PRO COSTS $79/MONTH.",
  "Acme's Pro plan costs $99/month or $79/month.",
  "Acme Pro: $99/month, Team: $79/month.",
  "Acme's Pro plan doesn't cost $79/month.",
  "Acme Pro might cost $79/month.",
  "I'm not sure but Acme Pro costs $79/month.",
  "Acme Pro costs $79.00/month.",
  "Acme Pro costs $079/month.",
  "Acme Pro costs $ 79/month.",
  "Acme Pro costs USD 79/month.",
  "Acme Pro costs 79 USD per month.",
  "Acme Pro costs $79,00/month.",
  "Acme Pro costs $1,049/month.",
  "Acme Pro costs $79-$99/month.",
  "Acme Pro costs $79 per month per user.",
  "Acme Pro costs $79/mo billed annually.",
  "Acme Pro costs $79 per month (billed annually).",
  "Acme Pro costs $79/month for the first 3 months.",
  "Acme Pro costs $79/month with 50% off.",
  "Acme Pro costs $79 flat per month.",
  "Acme Pro costs $79/month or $99/month for Team.",
]
const boolCases: Array<{ fact: unknown; answer: string }> = [
  { fact: capTrue, answer: "Acme supports Slack through Zapier only." },
  { fact: capTrue, answer: "Acme will support Slack soon." },
  { fact: capTrue, answer: "Acme's Slack integration is in beta." },
  { fact: capFalse, answer: "Acme does not currently support Slack natively." },
  { fact: capTrue, answer: "Acme offers a Slack integration." },
  { fact: capFalse, answer: "Acme offers a Slack integration." },
  { fact: planTrue, answer: "Acme Pro plan is no longer sold." },
  { fact: capFalse, answer: "Notion supports Slack, Acme doesn't." },
  { fact: capTrue, answer: "Notion supports Slack, Acme doesn't." },
  { fact: capTrue, answer: "Acme supports Slack and Teams." },
]
describe("zz-attack print", () => {
  it("prints price verdicts", () => {
    for (const a of priceCases) {
      const j = extractAssayJudgment(priceFact as never, a)
      const pm = parseMoneyFact(a)
      console.log(JSON.stringify({ answer: a, verdict: j.comparison, parsed: pm }))
    }
  })
  it("prints bool verdicts", () => {
    for (const c of boolCases) {
      const j = extractAssayJudgment(c.fact as never, c.answer)
      console.log(JSON.stringify({ answer: c.answer, factValue: (c.fact as { normalized: { value: boolean } }).normalized.value, factSubject: (c.fact as { subject: string }).subject, verdict: j.comparison }))
    }
  })
  it("prints direct compareMoneyClaim edge cases", () => {
    const f = priceFact.normalized
    for (const s of ["$79/month per head", "$79 per team per month", "$79/month for 5 users", "$79 per workspace per month", "USD 79/month", "79 USD per month", "$79-$99/month", "$79,00/month", "$ 79/month", "$079/month", "$79.00/month", "$1,049/month", "$79 each quarter", "$79 billed yearly"]) {
      console.log(JSON.stringify({ s, parsed: parseMoneyFact(s), cmp: (() => { try { return compareMoneyClaim(f as never, s) } catch (e) { return String(e) } })() }))
    }
  })
  it("prints plan-card proposals", () => {
    const htmls = [
      `<div class="pricing"><div class="card"><h3>Starter</h3><p>$19/month</p></div><div class="card"><h3>Pro</h3><p>$79/month</p><span>Most popular</span></div><div class="card"><h3>Team</h3><p>$149/month</p></div></div>`,
      `<table><tr><th>Starter</th><th>Pro</th><th>Team</th></tr><tr><td>$19/mo</td><td>$79/mo</td><td>$149/mo</td></tr></table>`,
      `<div><h3>Pro</h3><p>$99/month billed monthly</p><p>$79/month billed annually</p><label><input type="checkbox">Annual billing</label></div>`,
      `<div class="card"><h3>Pro</h3><p><s>$99/month</s> $79/month</p></div>`,
      `<div class="card"><h3>Pro</h3><p>$79 per seat per month</p></div><div class="card"><h3>Team</h3><p>$149 per month</p></div>`,
      `<div><h3>Starter</h3><p>$19/month</p><ul><li>Slack integration</li></ul></div><div><h3>Pro</h3><p>Contact us</p></div>`,
      `<div class="card"><h3>Pro</h3><p>From $79/month</p></div>`,
      `<div class="grid"><div><h3>Pro</h3></div><div><p>$79/month</p></div></div>`,
    ]
    for (const h of htmls) {
      const r = proposeAssayFacts(h, { subject: "Acme", businessName: "Acme", planTerms: ["Starter", "Pro", "Team"], capabilityTerms: ["Slack"] })
      console.log(JSON.stringify({ html: h.slice(0, 80), facts: r.facts }))
    }
  })
})
