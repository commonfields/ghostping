// Prospect-assay comparison V1 (Phase 2): normalized money facts, the
// comparison rule, and confirmation thresholds. Pure and deterministic:
// incomparable values yield UNCLEAR, never a manufactured contradiction.
//
// MoneyFact semantics (spec section 12): a price is amount + currency +
// billing period + unit + qualifier. Material differences in any of them
// (monthly vs annual, per-seat vs flat, USD vs EUR, starting-at vs fixed,
// promotion vs list) make the comparison UNCLEAR, not CONTRADICTS.



export type BillingPeriod = "MONTH" | "YEAR" | "ONE_TIME" | "UNKNOWN"
// UNSTATED: the span has no per-unit language at all (a plain "$49/month").
// UNKNOWN: per-unit language is present but unrecognized ("per agent") or
// contradictory, so the basis cannot be compared.
export type MoneyUnit = "ACCOUNT" | "USER" | "SEAT" | "LOCATION" | "USAGE_UNIT" | "UNSTATED" | "UNKNOWN"
export type MoneyQualifier = "EXACT" | "STARTING_AT" | "UP_TO" | "PROMOTIONAL" | "CONTACT_US" | "UNKNOWN"

export interface MoneyFact {
  readonly amountMinor: number
  readonly currency: string
  readonly billingPeriod: BillingPeriod
  readonly unit: MoneyUnit
  readonly qualifier: MoneyQualifier
}

const PERIOD_PATTERNS: ReadonlyArray<[BillingPeriod, RegExp]> = [
  ["MONTH", /\b(per\s+month|(?:a|each|every)\s+month|\bmonthly\b|\bmo\b)|\/\s*(?:mo|month)\b/i],
  ["YEAR", /\b(per\s+(?:year|annum)|(?:a|each|every)\s+year|\bannual(?:ly)?|yearly\b|\byr\b)|\/\s*(?:yr|year)\b/i],
  ["ONE_TIME", /\b(one-?time|once|lifetime|setup\s+fee)\b/i],
]

const UNIT_PATTERNS: ReadonlyArray<[MoneyUnit, RegExp]> = [
  ["SEAT", /\bper\s+seat\b|\/\s*seat\b/i],
  ["USER", /\bper\s+(?:active\s+)?user\b|\/\s*user\b|for\s+each\s+user\b/i],
  ["LOCATION", /\bper\s+location\b/i],
  ["USAGE_UNIT", /\bper\s+(?:1k|1000|million|gb|request|event)s?\b/i],
  ["ACCOUNT", /\bflat\b|\bper\s+account\b/i],
]

// Any "per <noun>" / "each <noun>" that is not a billing period names a basis.
const OTHER_UNIT_LANGUAGE = /\b(?:per|each|every)\s+(?!month\b|year\b|annum\b|mo\b|yr\b)\S|\/\s*(?!mo\b|month\b|yr\b|year\b)[a-z]|\bfor\s+(?:\d|each\b|every\b|all\b|(?:students?|nonprofits?|non-profits?|education(?:al)?|educators?|academic|startups?|government|schools?|charit\w*|individuals?|freelancers?)\b|(?:the\s+)?(?:whole|entire)\b|(?:a|your|the)\s+teams?\b|teams?\b)|\b(?:whole|entire)\s+(?:team|company|org)|\b(?:team|company|org(?:anization)?)-?wide\b/i

const QUALIFIER_PATTERNS: ReadonlyArray<[MoneyQualifier, RegExp]> = [
  ["STARTING_AT", /\b(start(?:s|ing)?\s+at|begins?\s+at|from|as\s+low\s+as)\b/i],
  ["UP_TO", /\bup\s+to\b/i],
  ["PROMOTIONAL", /\b(promo(?:tion(?:al)?)?|introductory|first\s+\d+\s+months?|discounted|sale|deal|black\s+friday)\b/i],
  ["CONTACT_US", /\b(contact\s+us|custom|talk\s+to\s+sales)\b/i],
]

const firstMatch = <T>(patterns: ReadonlyArray<[T, RegExp]>, text: string, fallback: T): T => {
  for (const [value, re] of patterns) if (re.test(text)) return value
  return fallback
}

// Currency-led, bounded digit groups avoid searching an unbounded digit suffix.
export const ASSAY_MAX_SPAN = 2000
export const ASSAY_MAX_TEXT = 1_000_000
const ISO = "USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|CNY|INR|SGD|HKD"
const NUMBER = "(?:\\d{1,3}(?:,\\d{3})+|\\d{1,12})(?:\\.\\d{1,2})?"
// A number ends where no digit, decimal/grouping continuation, or magnitude
// suffix follows; a sentence-final period is not a continuation.
const TAIL = "(?!\\d|[.,]\\d|\\s?[kKmMbB]\\b)"
const MONEY_CORE = new RegExp(`(?<![\\w$€£¥.,])(?:([$€£¥])\\s?(${NUMBER})${TAIL}|\\b(${ISO})\\s+(${NUMBER})${TAIL}|(${NUMBER})${TAIL}\\s+(${ISO})\\b)`)
export const priceMentionCount = (s: string): number =>
  s.length > ASSAY_MAX_SPAN ? 0 : (s.match(new RegExp(`[$€£¥]|\\b(?:${ISO})\\b`, "g"))?.length ?? 0)

/** Parse only unambiguous currency syntax; qualifiers cover the whole span. */
export const parseMoneyFact = (s: string): MoneyFact | null => {
  if (s.length > ASSAY_MAX_SPAN) return null
  const m = MONEY_CORE.exec(s)
  if (!m) return null
  const symbolCurrency: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" }
  const currency = m[1] ? symbolCurrency[m[1]]! : (m[3] ?? m[6])!
  const amount = Number((m[2] ?? m[4] ?? m[5])!.replaceAll(",", ""))
  const amountMinor = Math.round(amount * (currency === "JPY" ? 1 : 100))
  if (!Number.isSafeInteger(amountMinor)) return null
  const periods = PERIOD_PATTERNS.filter(([, re]) => re.test(s))
  const units = UNIT_PATTERNS.filter(([, re]) => re.test(s))
  const qualifiers = QUALIFIER_PATTERNS.filter(([, re]) => re.test(s))
  return {
    amountMinor, currency,
    billingPeriod: periods.length === 1 ? periods[0]![0] : "UNKNOWN",
    unit: units.length === 1 ? units[0]![0] : units.length === 0 && !OTHER_UNIT_LANGUAGE.test(s) ? "UNSTATED" : "UNKNOWN",
    qualifier: /%\s*off/i.test(s) ? "PROMOTIONAL" : qualifiers.length > 1 ? "UNKNOWN" : firstMatch(QUALIFIER_PATTERNS, s, "EXACT"),
  }
}

const SYMBOL_FOR: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" }

/** Narrow textual variants of one disputed amount (spec section 17). */
export const moneyVariants = (money: { readonly amountMinor: number; readonly currency: string }): string[] => {
  const value = money.amountMinor / (money.currency === "JPY" ? 1 : 100)
  const amount = Number.isInteger(value) ? String(value) : value.toFixed(2)
  const symbol = SYMBOL_FOR[money.currency]
  return symbol ? [`${symbol}${amount}`, `${amount}/mo`, `${symbol}${amount}/month`, `${symbol}${amount} per month`] : [`${amount} ${money.currency}`]
}

/** Index of a whole-amount occurrence: "$49" never matches "$149",
 * "$49,000", "$49.50" or "$49k", but does match a sentence-final "$49.". */
export const findMoneyVariant = (text: string, variant: string): number => {
  const literal = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![\\w.,])${literal}${TAIL}`).exec(text.slice(0, ASSAY_MAX_TEXT))?.index ?? -1
}

export type ClaimComparison = "MATCHES" | "CONTRADICTS" | "NOT_MENTIONED" | "UNCLEAR"

// Comparable only when both sides disclose the identical basis, or both say
// nothing about a unit; "per agent" (UNKNOWN) never compares with anything.
const unitsCompatible = (a: MoneyUnit, b: MoneyUnit): boolean => a !== "UNKNOWN" && a === b

/**
 * Compare one answer sample against a confirmed MoneyFact.
 * NOT_MENTIONED when the sample states no price at all; UNCLEAR when
 * comparison semantics differ or are unresolved; CONTRADICTS only for a
 * definite same-basis disagreement.
 */
export const compareMoneyClaim = (fact: MoneyFact, sampleAnswer: string): ClaimComparison => {
  if (sampleAnswer.length > ASSAY_MAX_SPAN) return "UNCLEAR"
  const seen = parseMoneyFact(sampleAnswer)
  if (seen === null) return "NOT_MENTIONED"
  if (seen.currency !== fact.currency || fact.billingPeriod === "UNKNOWN" || seen.billingPeriod === "UNKNOWN" || fact.qualifier === "UNKNOWN" || seen.qualifier === "UNKNOWN") return "UNCLEAR"
  if (seen.amountMinor === fact.amountMinor) {
    return fact.billingPeriod === seen.billingPeriod && unitsCompatible(fact.unit, seen.unit) && fact.qualifier === seen.qualifier
      ? "MATCHES"
      : "UNCLEAR"
  }
  // Different numbers contradict only on the same disclosed basis: equal
  // periods, compatible units, and the same non-promotional qualifier.
  // Undisclosed or conflicting periods were rejected above.
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
  // Preserve the N=5 rule while scaling to the successful denominator.
  // A single answer cannot establish repeated evidence, even after failures.
  if (contradictCount >= 3 && contradictCount / sampleCount >= 0.6) return "CONFIRMED"
  if (contradictCount >= 2 && contradictCount / sampleCount >= 0.4) return "OBSERVED_INTERMITTENT"
  return "ANECDOTAL"
}
