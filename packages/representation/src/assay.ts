// Prospect-assay comparison V1 (Phase 2): normalized money facts, the
// comparison rule, and confirmation thresholds. Pure and deterministic:
// incomparable values yield UNCLEAR, never a manufactured contradiction.
//
// MoneyFact semantics (spec section 12): a price is amount + currency +
// billing period + unit + qualifier. Material differences in any of them
// (monthly vs annual, per-seat vs flat, USD vs EUR, starting-at vs fixed,
// promotion vs list) make the comparison UNCLEAR, not CONTRADICTS.

import { parseMoney } from "./comparators.js"

export type BillingPeriod = "MONTH" | "YEAR" | "ONE_TIME" | "UNKNOWN"
export type MoneyUnit = "ACCOUNT" | "USER" | "SEAT" | "LOCATION" | "USAGE_UNIT" | "UNKNOWN"
export type MoneyQualifier = "EXACT" | "STARTING_AT" | "UP_TO" | "PROMOTIONAL" | "CONTACT_US" | "UNKNOWN"

export interface MoneyFact {
  readonly amountMinor: number
  readonly currency: string
  readonly billingPeriod: BillingPeriod
  readonly unit: MoneyUnit
  readonly qualifier: MoneyQualifier
}

const PERIOD_PATTERNS: ReadonlyArray<[BillingPeriod, RegExp]> = [
  ["MONTH", /\b(per\s+month|\/\s*mo\b|\/\s*month\b|\bmonthly\b|\bmo\b)/i],
  ["YEAR", /\b(per\s+year|\/\s*yr\b|\/\s*year\b|\bannual(?:ly)?\b|\byr\b)/i],
  ["ONE_TIME", /\b(one-?time|once|lifetime|setup\s+fee)\b/i],
]

const UNIT_PATTERNS: ReadonlyArray<[MoneyUnit, RegExp]> = [
  ["SEAT", /\bper\s+seat\b|\/\s*seat\b/i],
  ["USER", /\bper\s+user\b|\/\s*user\b/i],
  ["LOCATION", /\bper\s+location\b/i],
  ["USAGE_UNIT", /\bper\s+(?:1k|1000|million|gb|request|event)s?\b/i],
  ["ACCOUNT", /\bflat\b|\bper\s+account\b/i],
]

const QUALIFIER_PATTERNS: ReadonlyArray<[MoneyQualifier, RegExp]> = [
  ["STARTING_AT", /\b(starting\s+at|from|as\s+low\s+as)\b/i],
  ["UP_TO", /\bup\s+to\b/i],
  ["PROMOTIONAL", /\b(promo(?:tion(?:al)?)?|introductory|first\s+\d+\s+months?|discounted|sale)\b/i],
  ["CONTACT_US", /\b(contact\s+us|custom|talk\s+to\s+sales)\b/i],
]

const firstMatch = <T>(patterns: ReadonlyArray<[T, RegExp]>, text: string, fallback: T): T => {
  for (const [value, re] of patterns) if (re.test(text)) return value
  return fallback
}

// A money core must carry an explicit currency (symbol or ISO code); a bare
// number is not a price and yields no fact.
const MONEY_CORE = /(?:[A-Z]{3}\s+)?[$€£¥]\s*-?\d[\d,]*(?:\.\d+)?(?:\s*[A-Z]{3})?|-?\d[\d,]*(?:\.\d+)?\s*[A-Z]{3}/

/** Parse a price mention inside free text into a MoneyFact; null when none. */
export const parseMoneyFact = (s: string): MoneyFact | null => {
  const m = MONEY_CORE.exec(s)
  if (!m) return null
  const core = m[0]
  // Qualifier/period/unit signals live around the mention, not in it.
  const start = Math.max(0, (m.index ?? 0) - 48)
  const context = s.slice(start, (m.index ?? 0) + core.length + 48)
  const base = parseMoney(core.trim())
  if (base === null || base.currency === null) return null
  return {
    amountMinor: base.amountMinor,
    currency: base.currency,
    billingPeriod: firstMatch(PERIOD_PATTERNS, context, "UNKNOWN"),
    unit: firstMatch(UNIT_PATTERNS, context, "UNKNOWN"),
    qualifier: firstMatch(QUALIFIER_PATTERNS, context, "EXACT"),
  }
}

export type ClaimComparison = "MATCHES" | "CONTRADICTS" | "NOT_MENTIONED" | "UNCLEAR"

/** Units compare unless both sides disclose different ones explicitly. */
const unitsCompatible = (a: MoneyUnit, b: MoneyUnit): boolean => a === b || a === "UNKNOWN" || b === "UNKNOWN"

/**
 * Compare one answer sample against a confirmed MoneyFact.
 * NOT_MENTIONED when the sample states no price at all; UNCLEAR when
 * comparison semantics differ or are unresolved; CONTRADICTS only for a
 * definite same-basis disagreement.
 */
export const compareMoneyClaim = (fact: MoneyFact, sampleAnswer: string): ClaimComparison => {
  const seen = parseMoneyFact(sampleAnswer)
  if (seen === null) return "NOT_MENTIONED"
  if (seen.currency !== fact.currency) return "UNCLEAR"
  if (seen.amountMinor === fact.amountMinor) {
    return fact.billingPeriod === seen.billingPeriod && unitsCompatible(fact.unit, seen.unit) && fact.qualifier === seen.qualifier
      ? "MATCHES"
      : "UNCLEAR"
  }
  // Different numbers contradict only on the same disclosed basis: equal
  // periods (both undisclosed counts as the same undisclosed basis),
  // compatible units, and the same non-promotional qualifier.
  if (
    fact.billingPeriod === seen.billingPeriod &&
    unitsCompatible(fact.unit, seen.unit) &&
    fact.qualifier === seen.qualifier &&
    fact.qualifier !== "PROMOTIONAL"
  ) {
    return "CONTRADICTS"
  }
  return "UNCLEAR"
}

export type ConfirmationVerdict = "ANECDOTAL" | "OBSERVED_INTERMITTENT" | "CONFIRMED"

/** N=5 thresholds: 1/5 ANECDOTAL, 2/5 OBSERVED_INTERMITTENT, 3-5/5 CONFIRMED. */
export const confirmThreshold = (contradictCount: number, sampleCount: number): ConfirmationVerdict => {
  if (!Number.isInteger(contradictCount) || !Number.isInteger(sampleCount) || sampleCount <= 0 || contradictCount < 0 || contradictCount > sampleCount) {
    throw new Error(`confirmThreshold: invalid counts ${contradictCount}/${sampleCount}`)
  }
  // Zero contradictions is not a confirmation level: no finding exists, so
  // no verdict may be constructed for it. Callers create a finding row only
  // when contradictCount >= 1; this throws rather than label 0/5 ANECDOTAL.
  if (contradictCount === 0) throw new Error("confirmThreshold: no contradictions produce no finding")
  if (contradictCount >= 3) return "CONFIRMED"
  if (contradictCount === 2) return "OBSERVED_INTERMITTENT"
  return "ANECDOTAL"
}
