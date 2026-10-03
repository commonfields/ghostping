// Typed manifest fact values V1: text | boolean | money.
// Money amounts are decimal strings, never binary floats. The canonical
// form preserves authored scale ("49.00" stays "49.00"); only signs and
// leading zeros normalize. Currency is always explicit, never inferred.

export type ManifestValueType = "text" | "boolean" | "money"

export type ManifestValue =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "money"; readonly amount: string; readonly currency: string }

export class ManifestInvalid extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail === undefined ? `ManifestInvalid: ${code}` : `ManifestInvalid: ${code}: ${detail}`)
  }
}

const DECIMAL = /^[+-]?\d+(\.\d+)?$/
const CURRENCY = /^[A-Z]{3}$/

/** Canonical decimal: no exponent, no plus, minimal integer part, kept scale. */
export const canonicalAmount = (raw: unknown): string => {
  if (typeof raw !== "string" || !DECIMAL.test(raw)) {
    throw new ManifestInvalid("InvalidMoney", typeof raw === "string" ? raw : typeof raw)
  }
  const rest = raw.startsWith("+") ? raw.slice(1) : raw
  const wasNegative = rest.startsWith("-")
  const digits = wasNegative ? rest.slice(1) : rest
  const dot = digits.indexOf(".")
  let int = dot === -1 ? digits : digits.slice(0, dot)
  const frac = dot === -1 ? null : digits.slice(dot + 1)
  int = int.replace(/^0+(?=\d)/, "")
  if (int === "") int = "0"
  const negative = wasNegative && !(int === "0" && (frac === null || /^[0]+$/.test(frac)))
  return `${negative ? "-" : ""}${int}${frac === null ? "" : `.${frac}`}`
}

export const canonicalCurrency = (raw: unknown): string => {
  if (typeof raw !== "string" || !CURRENCY.test(raw)) throw new ManifestInvalid("InvalidCurrency", String(raw))
  return raw
}

export const parseManifestValue = (type: string, value: unknown): ManifestValue => {
  if (type === "text") {
    if (typeof value !== "string") throw new ManifestInvalid("InvalidTextValue", typeof value)
    return { type: "text", value }
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new ManifestInvalid("InvalidBooleanValue", typeof value)
    return { type: "boolean", value }
  }
  if (type === "money") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ManifestInvalid("InvalidMoney")
    const v = value as Record<string, unknown>
    const keys = Object.keys(v).sort()
    if (keys.join(",") !== "amount,currency") throw new ManifestInvalid("InvalidMoneyShape", keys.join(","))
    return { type: "money", amount: canonicalAmount(v["amount"]), currency: canonicalCurrency(v["currency"]) }
  }
  throw new ManifestInvalid("InvalidFactType", type)
}

// ---------------------------------------------------------------------------
// AuthoritativeFact bridge: one deterministic mapping, documented here.
// value_type reuses the existing hosted enum (TEXT | BOOLEAN | CURRENCY).
// money encodes as "<amount> <CURRENCY>" (e.g. "49.00 USD").
// boolean encodes as "true" | "false". text is the raw string.
// decodeBridge returns null for non-canonical legacy inputs (one-way only).
// ---------------------------------------------------------------------------

export interface BridgedFact {
  readonly value_text: string
  readonly value_type: "TEXT" | "BOOLEAN" | "CURRENCY"
}

export const encodeBridge = (v: ManifestValue): BridgedFact => {
  switch (v.type) {
    case "text":
      return { value_text: v.value, value_type: "TEXT" }
    case "boolean":
      return { value_text: v.value ? "true" : "false", value_type: "BOOLEAN" }
    case "money":
      return { value_text: `${v.amount} ${v.currency}`, value_type: "CURRENCY" }
  }
}

export const decodeBridge = (value_text: string, value_type: string): ManifestValue | null => {
  try {
    if (value_type === "TEXT") return { type: "text", value: value_text }
    if (value_type === "BOOLEAN") {
      if (value_text === "true") return { type: "boolean", value: true }
      if (value_text === "false") return { type: "boolean", value: false }
      return null
    }
    if (value_type === "CURRENCY") {
      const m = value_text.match(/^(-?\d+(?:\.\d+)?) ([A-Z]{3})$/)
      if (!m) return null
      return { type: "money", amount: canonicalAmount(m[1]), currency: canonicalCurrency(m[2]) }
    }
    return null
  } catch {
    return null
  }
}

/** Semantic equality on canonical forms (scale-sensitive for money). */
export const sameValue = (a: ManifestValue, b: ManifestValue): boolean => {
  if (a.type !== b.type) return false
  if (a.type === "text") return a.value === (b as { value: string }).value
  if (a.type === "boolean") return a.value === (b as { value: boolean }).value
  const m = b as { amount: string; currency: string }
  return a.type === "money" && a.amount === m.amount && a.currency === m.currency
}
