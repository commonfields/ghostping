// Assay comparison V1: deterministic fixtures proving the comparison rule
// (UNCLEAR, never manufactured contradiction) and the N=5 thresholds.
import { describe, expect, it } from "vitest"
import { compareMoneyClaim, confirmThreshold, parseMoneyFact, type MoneyFact } from "../src/assay.js"

const FACT: MoneyFact = {
  amountMinor: 7900,
  currency: "USD",
  billingPeriod: "MONTH",
  unit: "ACCOUNT",
  qualifier: "EXACT",
}

describe("parseMoneyFact", () => {
  it("parses amount, currency, period, unit, qualifier", () => {
    expect(parseMoneyFact("$79 per month")).toMatchObject({
      amountMinor: 7900,
      currency: "USD",
      billingPeriod: "MONTH",
      qualifier: "EXACT",
    })
    expect(parseMoneyFact("Starting at $49/mo per seat")).toMatchObject({
      amountMinor: 4900,
      billingPeriod: "MONTH",
      unit: "SEAT",
      qualifier: "STARTING_AT",
    })
  })

  it("returns null when no money is stated", () => {
    expect(parseMoneyFact("contact us for pricing")).toBeNull()
    expect(parseMoneyFact("it is great software")).toBeNull()
  })
})

describe("compareMoneyClaim", () => {
  it("MATCHES the same disclosed basis", () => {
    expect(compareMoneyClaim(FACT, "It's $79 per month.")).toBe("MATCHES")
  })

  it("CONTRADICTS only on the same disclosed basis", () => {
    expect(compareMoneyClaim(FACT, "It costs $49 per month.")).toBe("CONTRADICTS")
  })

  it("NOT_MENTIONED when the sample states no price", () => {
    expect(compareMoneyClaim(FACT, "I don't have enough info.")).toBe("NOT_MENTIONED")
  })

  it("UNCLEAR across currencies without conversion", () => {
    expect(compareMoneyClaim(FACT, "It costs €79 per month.")).toBe("UNCLEAR")
  })

  it("UNCLEAR monthly vs annual", () => {
    expect(compareMoneyClaim({ ...FACT, amountMinor: 94800 }, "It costs $948 per year.")).toBe("UNCLEAR")
  })

  it("UNCLEAR starting-at vs fixed", () => {
    expect(compareMoneyClaim(FACT, "Starting at $79 per month.")).toBe("UNCLEAR")
  })

  it("UNCLEAR promotion vs list price", () => {
    expect(compareMoneyClaim(FACT, "It's $49 per month for the first 3 months.")).toBe("UNCLEAR")
  })

  it("UNCLEAR when the period is undisclosed on either side", () => {
    expect(compareMoneyClaim(FACT, "It costs $79.")).toBe("UNCLEAR")
    expect(compareMoneyClaim({ ...FACT, billingPeriod: "UNKNOWN" }, "It costs $79 per month.")).toBe("UNCLEAR")
  })

  it("UNCLEAR on explicit per-seat vs flat mismatch", () => {
    const seatFact: MoneyFact = { ...FACT, unit: "SEAT" }
    expect(compareMoneyClaim(seatFact, "It costs $49 flat per month.")).toBe("UNCLEAR")
  })
})

describe("confirmThreshold", () => {
  it("maps 1/5 ANECDOTAL, 2/5 OBSERVED_INTERMITTENT, 3-5/5 CONFIRMED", () => {
    expect(confirmThreshold(1, 5)).toBe("ANECDOTAL")
    expect(confirmThreshold(2, 5)).toBe("OBSERVED_INTERMITTENT")
    for (const c of [3, 4, 5]) expect(confirmThreshold(c, 5)).toBe("CONFIRMED")
  })

  it("refuses to construct a verdict from zero contradictions", () => {
    expect(() => confirmThreshold(0, 5)).toThrow(/no finding/)
  })

  it("rejects invalid counts", () => {
    for (const [c, n] of [[-1, 5], [6, 5], [2, 0], [1.5, 5]] as const) {
      expect(() => confirmThreshold(c, n)).toThrow(/invalid counts/)
    }
  })
})
