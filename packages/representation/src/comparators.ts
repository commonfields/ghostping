// Deterministic comparators V1: EXACT_TEXT, BOOLEAN, MONEY.
// UNKNOWN semantics: absence/malformed/unknown-currency → UNKNOWN, never false.

import type { RepresentationState } from "./types.js"

export const normalizeExactText = (s: string): string =>
  // Unicode NFC + CRLF/CR → LF. No case folding, no trimming beyond line endings.
  s.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n")

export const compareExactText = (authority: string, observed: string): RepresentationState =>
  normalizeExactText(authority) === normalizeExactText(observed) ? "IN_SYNC" : "DRIFT"

const TRUE_TOKENS = new Set(["true", "yes", "1", "on", "enabled"])
const FALSE_TOKENS = new Set(["false", "no", "0", "off", "disabled"])

export const parseBoolean = (s: string): boolean | null => {
  const t = s.trim().toLowerCase()
  if (TRUE_TOKENS.has(t)) return true
  if (FALSE_TOKENS.has(t)) return false
  return null
}

export const compareBoolean = (authority: string, observed: string): RepresentationState => {
  const a = parseBoolean(authority)
  const b = parseBoolean(observed)
  if (a === null || b === null) return "UNKNOWN"
  return a === b ? "IN_SYNC" : "DRIFT"
}

export interface MoneyValue {
  readonly amountMinor: number
  readonly currency: string | null
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
}

export const parseMoney = (s: string): MoneyValue | null => {
  const text = s.trim()
  // Capture optional symbol/code prefix/suffix + numeric amount.
  const m = text.match(/^(?<pre>[A-Z]{3}|[$€£¥])?\s*(?<num>-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(?<post>[A-Z]{3})?$/)
  if (!m || !m.groups) return null
  const pre = (m.groups["pre"] ?? "").trim()
  const post = (m.groups["post"] ?? "").trim()
  let currency: string | null = null
  if (pre.length === 3 && /^[A-Z]{3}$/.test(pre)) currency = pre
  else if (pre.length === 1 && CURRENCY_SYMBOLS[pre] !== undefined) currency = CURRENCY_SYMBOLS[pre]!
  if (post.length === 3 && /^[A-Z]{3}$/.test(post)) {
    if (currency !== null && currency !== post) return null
    currency = post
  } else if (post.length > 0) return null
  const numeric = (m.groups["num"] ?? "").replace(/,/g, "")
  const amount = Number(numeric)
  if (!Number.isFinite(amount)) return null
  // Minor units: assume 2dp except JPY (0dp). Unknown currencies → 2dp.
  const decimals = currency === "JPY" ? 0 : 2
  return { amountMinor: Math.round(amount * 10 ** decimals), currency }
}

/**
 * Money comparison.
 * - Both must parse; else UNKNOWN.
 * - If either currency is missing → UNKNOWN (never infer from location).
 * - Same amount+currency → IN_SYNC else DRIFT.
 */
export const compareMoney = (authority: string, observed: string): RepresentationState => {
  const a = parseMoney(authority)
  const b = parseMoney(observed)
  if (a === null || b === null) return "UNKNOWN"
  if (a.currency === null || b.currency === null) return "UNKNOWN"
  return a.currency === b.currency && a.amountMinor === b.amountMinor ? "IN_SYNC" : "DRIFT"
}
