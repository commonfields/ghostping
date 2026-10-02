// Canonical JSON for evidence packets. The Rust implementation in
// `src/evidence_protocol.rs` must produce identical bytes; shared vectors in
// `fixtures/evidence-protocol-v1/canonical-vectors.json` pin the agreement.
import { createHash } from "node:crypto"

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Unicode code-point order (equals UTF-8 byte order). JS's default sort
 * compares UTF-16 code units, which disagrees for astral characters. */
export const compareCodePoints = (a: string, b: string): number => {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  return Buffer.compare(ab, bb)
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Numbers serialize with ECMAScript Number::toString (shortest round-trip).
 * Integer-valued numbers beyond ±(2^53−1) are rejected because readers in
 * other languages would not agree on their value. Strings must be
 * well-formed Unicode (no lone surrogates).
 */
export const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) throw new Error("CanonicalJsonError: lone surrogate")
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CanonicalJsonError: non-finite number")
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("CanonicalJsonError: unsafe integer")
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort(compareCodePoints)) {
      if (LONE_SURROGATE.test(key)) throw new Error("CanonicalJsonError: lone surrogate")
      const child = value[key]
      if (child !== undefined) out[key] = canonicalize(child)
    }
    return out
  }
  throw new Error(`CanonicalJsonError: unsupported ${typeof value}`)
}

/** Serialize with keys in code-point order. Objects are written explicitly
 * because JSON.stringify always hoists integer-like keys. */
export const canonicalJson = (value: unknown): string => {
  const write = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(write).join(",")}]`
    if (isPlainObject(v)) return `{${Object.keys(v).sort(compareCodePoints).map((k) => `${JSON.stringify(k)}:${write(v[k])}`).join(",")}}`
    return JSON.stringify(v)
  }
  return write(canonicalize(value))
}

export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
