// Representation finding derivation: AuthoritativeFact vs ObservedSourceValue.
// comparable known value == authority → IN_SYNC
// comparable known value != authority → DRIFT
// fetch/extraction/comparison uncertainty → UNKNOWN
// Never convert absence into contradiction.

import { compareBoolean, compareExactText, compareMoney } from "./comparators.js"
import type {
  ObservedSourceValueV1,
  RepresentationFindingV1,
  SourceBindingV1,
} from "./types.js"

export const deriveFinding = (
  authority: { readonly id: string; readonly value_text: string },
  binding: SourceBindingV1,
  observationId: string,
  value: ObservedSourceValueV1 | null,
): RepresentationFindingV1 => {
  if (value === null || value.extraction_state !== "OBSERVED" || value.extracted_value === null) {
    const reason =
      value === null
        ? "no extraction attempted"
        : value.extraction_state === "NOT_FOUND"
          ? "selector found no value"
          : value.extraction_state === "AMBIGUOUS"
            ? "multiple conflicting values"
            : value.extraction_state === "UNSUPPORTED"
              ? "unsupported source value"
              : "extraction failed"
    return {
      fact_id: authority.id,
      source_binding_id: binding.id,
      source_observation_id: observationId,
      observed_value_id: value?.id ?? null,
      state: "UNKNOWN",
      reason,
    }
  }
  const observed = value.extracted_value
  const state =
    binding.comparator === "EXACT_TEXT"
      ? compareExactText(authority.value_text, observed)
      : binding.comparator === "BOOLEAN"
        ? compareBoolean(authority.value_text, observed)
        : compareMoney(authority.value_text, observed)
  if (state === "UNKNOWN") {
    return {
      fact_id: authority.id,
      source_binding_id: binding.id,
      source_observation_id: observationId,
      observed_value_id: value.id,
      state: "UNKNOWN",
      reason: "comparison uncertain (missing currency, malformed value, or unsupported boolean)",
    }
  }
  return {
    fact_id: authority.id,
    source_binding_id: binding.id,
    source_observation_id: observationId,
    observed_value_id: value.id,
    state,
    reason: state === "IN_SYNC" ? "observed equals authority" : "observed differs from authority",
  }
}
