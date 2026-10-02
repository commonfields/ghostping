// Measurement signatures, match classification, and outcome derivation.
// Rust mirrors these rules in `src/evidence_protocol.rs`; every golden
// fixture is re-derived by both languages during validation.
import { canonicalJson, compareCodePoints, sha256 } from "./canonical.js"
import type {
  ClaimV1,
  FactV1,
  JudgmentV1,
  MatchClassification,
  MeasurementContextV1,
  MeasurementSignatureV1,
  ObservedChange,
  ObservedOutcome,
  Verdict,
} from "./schema.js"

export const measurementSignature = (context: MeasurementContextV1): MeasurementSignatureV1 => ({
  business_id: context.business_id,
  question_id: context.question_id,
  question_version: context.question_version,
  // Exact bytes of the prompt; no trimming or whitespace normalization.
  exact_question_digest: sha256(context.question),
  surface_kind: context.surface.kind,
  product: context.surface.product,
  adapter: context.surface.adapter,
  adapter_version: context.surface.adapter_version,
  gateway: context.surface.gateway,
  requested_provider: context.surface.requested_provider,
  requested_model: context.surface.requested_model,
  observed_provider: context.surface.observed_provider,
  observed_model: context.surface.observed_model,
  search_mode: context.surface.search_mode,
  locale: context.surface.locale,
  region: context.surface.region,
  personalization_state: context.surface.personalization_state,
  generation_configuration: context.measurement_configuration,
})

type KnowledgeKey = {
  [K in keyof MeasurementSignatureV1]: MeasurementSignatureV1[K] extends { readonly state: string } ? K : never
}[keyof MeasurementSignatureV1]

/** Dimensions whose UNKNOWN makes comparison INDETERMINATE. */
export const CRITICAL_DIMENSIONS: ReadonlyArray<KnowledgeKey> = [
  "gateway",
  "requested_provider",
  "requested_model",
  "search_mode",
  "personalization_state",
  "generation_configuration",
]
/** Dimensions whose UNKNOWN downgrades an otherwise exact match to COMPARABLE. */
export const SUPPORTING_DIMENSIONS: ReadonlyArray<KnowledgeKey> = [
  "question_version",
  "observed_provider",
  "observed_model",
  "locale",
  "region",
]
const IDENTITY_KEYS = ["business_id", "question_id", "exact_question_digest", "surface_kind", "product", "adapter"] as const

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

/**
 * Classify whether two measurements are comparable.
 *
 * 1. Identity (business, question, exact prompt, surface kind/product/adapter)
 *    differs → NOT_COMPARABLE.
 * 2. Any Knowledge dimension established on both sides (KNOWN or
 *    NOT_APPLICABLE) but different → NOT_COMPARABLE.
 * 3. Any critical dimension UNKNOWN on either side → INDETERMINATE.
 * 4. Any supporting dimension UNKNOWN on either side, or a different adapter
 *    version → COMPARABLE.
 * 5. Otherwise → EXACT_MATCH.
 *
 * UNKNOWN never participates in an equality proof: EXACT_MATCH is reachable
 * only when no dimension is UNKNOWN on either side.
 */
export const compareMeasurements = (a: MeasurementSignatureV1, b: MeasurementSignatureV1): MatchClassification => {
  if (IDENTITY_KEYS.some((k) => a[k] !== b[k])) return "NOT_COMPARABLE"
  const dims = [...CRITICAL_DIMENSIONS, ...SUPPORTING_DIMENSIONS]
  for (const k of dims) {
    const av = a[k]
    const bv = b[k]
    if (av.state !== "UNKNOWN" && bv.state !== "UNKNOWN" && !same(av, bv)) return "NOT_COMPARABLE"
  }
  if (CRITICAL_DIMENSIONS.some((k) => a[k].state === "UNKNOWN" || b[k].state === "UNKNOWN")) return "INDETERMINATE"
  if (SUPPORTING_DIMENSIONS.some((k) => a[k].state === "UNKNOWN" || b[k].state === "UNKNOWN")) return "COMPARABLE"
  if (a.adapter_version !== b.adapter_version) return "COMPARABLE"
  return "EXACT_MATCH"
}

const usable = (match: MatchClassification) => match === "EXACT_MATCH" || match === "COMPARABLE"

/** Answer-text change between two observations; only meaningful when comparable. */
export const deriveObservedChange = (match: MatchClassification, beforeText: string, afterText: string): ObservedChange => {
  if (!usable(match)) return "INDETERMINATE"
  return beforeText === afterText ? "NO_CHANGE" : "CHANGED"
}

/** Outcome derives only from explicit before/after judgments on a usable
 * comparison. It never asserts causality. */
export const deriveOutcome = (
  before: Verdict | null,
  after: Verdict | null,
  match: MatchClassification,
  change: ObservedChange,
): ObservedOutcome => {
  if (!usable(match) || before === null || after === null) return "INDETERMINATE"
  if (before === "CONTRADICTED" && after === "SUPPORTED") return "OBSERVED_CORRECTION"
  if (before === "SUPPORTED" && after === "CONTRADICTED") return "OBSERVED_REGRESSION"
  if (before !== after) return "OBSERVED_DIFFERENCE"
  return change === "CHANGED" ? "OBSERVED_DIFFERENCE" : "NO_OBSERVED_CHANGE"
}

/** Code-point order on (created_at, id); identical to the Rust reader. */
const byTimeThenId = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) =>
  compareCodePoints(a.created_at, b.created_at) || compareCodePoints(a.id, b.id)

/** Current head of a claim's append-only judgment chain (null when unjudged). */
export const latestJudgment = (judgments: ReadonlyArray<JudgmentV1>, claimId: string): JudgmentV1 | null => {
  const chain = judgments.filter((j) => j.claim_id === claimId)
  const superseded = new Set(chain.flatMap((j) => (j.supersedes_id === null ? [] : [j.supersedes_id])))
  const heads = chain.filter((j) => !superseded.has(j.id)).sort(byTimeThenId)
  return heads.at(-1) ?? null
}

/** The single claim on a re-observation; null when none or ambiguous. */
export const soleClaim = (claims: ReadonlyArray<ClaimV1>, observationId: string): ClaimV1 | null => {
  const own = claims.filter((c) => c.observation_id === observationId)
  return own.length === 1 ? (own[0] ?? null) : null
}

/** Authority versions valid at an instant. Returns all overlaps so authority
 * conflicts stay explicit and never auto-resolve. Intervals are [from, until). */
export const factsAt = (facts: ReadonlyArray<FactV1>, at: string): ReadonlyArray<FactV1> => {
  const t = Date.parse(at)
  if (Number.isNaN(t)) throw new Error("InvalidMeasurementTimestamp")
  return facts.filter((fact) => {
    const from = Date.parse(fact.valid_from)
    const until = fact.valid_until === null ? Number.POSITIVE_INFINITY : Date.parse(fact.valid_until)
    return from <= t && t < until
  })
}

export { byTimeThenId }
