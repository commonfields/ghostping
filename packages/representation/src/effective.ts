// Effective evidence resolution: which observation attempt, which
// successful check, and which extracted value determine the CURRENT
// representation finding. A 304 NOT_MODIFIED (or a FETCHED collection with
// unchanged digest and skipped extraction) creates NO new value row — that
// proves the previous representation is unchanged and must NOT erase it.
//
// Three explicit concepts, which may point at different rows:
//   latest_attempt            newest collection of any state (incl. FAILED)
//   latest_successful_check   newest FETCHED / NOT_MODIFIED
//   effective_value_observation  newest successful check carrying a usable
//                             extracted value (walked back across 304s)
import { deriveFinding } from "./evaluate.js"
import type {
  ObservedSourceValueV1,
  RepresentationFindingV1,
  SourceBindingV1,
  SourceObservationV1,
} from "./types.js"

export const isSuccessfulCollection = (collectionState: string): boolean =>
  collectionState === "FETCHED" || collectionState === "NOT_MODIFIED"

export interface EffectiveEvidence {
  readonly latestAttempt: SourceObservationV1 | null
  readonly latestSuccessfulCheck: SourceObservationV1 | null
  readonly effectiveValueObservation: SourceObservationV1 | null
  readonly effectiveValue: ObservedSourceValueV1 | null
  readonly finding: RepresentationFindingV1
}

const byCompleted = (a: SourceObservationV1, b: SourceObservationV1): number =>
  a.completed_at.localeCompare(b.completed_at) || a.id.localeCompare(b.id)

export const resolveEffectiveEvidence = (
  fact: { readonly id: string; readonly value_text: string },
  binding: SourceBindingV1,
  targetObservations: ReadonlyArray<SourceObservationV1>,
  bindingValues: ReadonlyArray<ObservedSourceValueV1>,
): EffectiveEvidence => {
  const ordered = [...targetObservations].sort(byCompleted)
  const latestAttempt = ordered.length > 0 ? (ordered[ordered.length - 1] ?? null) : null
  const successful = ordered.filter((o) => isSuccessfulCollection(o.collection_state))
  const latestSuccessfulCheck = successful.length > 0 ? (successful[successful.length - 1] ?? null) : null
  const valueByObservation = new Map(bindingValues.map((v) => [v.source_observation_id, v] as const))
  // Walk back from the newest successful check to the newest one that
  // actually carries an extracted value (304s and unchanged-digest
  // reuses deliberately store none).
  let effectiveValueObservation: SourceObservationV1 | null = null
  let effectiveValue: ObservedSourceValueV1 | null = null
  for (let i = successful.length - 1; i >= 0; i--) {
    const candidate = successful[i]!
    const value = valueByObservation.get(candidate.id) ?? null
    if (value !== null) {
      effectiveValueObservation = candidate
      effectiveValue = value
      break
    }
  }
  const anchor = effectiveValueObservation?.id ?? latestSuccessfulCheck?.id ?? latestAttempt?.id ?? ""
  return {
    latestAttempt,
    latestSuccessfulCheck,
    effectiveValueObservation,
    effectiveValue,
    finding: deriveFinding(fact, binding, anchor, effectiveValue),
  }
}

export interface EffectiveHistoryEntry {
  readonly observation_id: string
  readonly completed_at: string
  readonly collection_state: string
  readonly state: string
  readonly reason: string
  readonly extracted_value: string | null
}

/**
 * Per-observation history: FETCHED derives from its own value (or the
 * walked-back effective value when extraction was skipped as unchanged);
 * NOT_MODIFIED derives from the walked-back value as IN_SYNC/unchanged;
 * FAILED is UNKNOWN for that individual attempt only.
 */
export const resolveHistory = (
  fact: { readonly id: string; readonly value_text: string },
  binding: SourceBindingV1,
  targetObservations: ReadonlyArray<SourceObservationV1>,
  bindingValues: ReadonlyArray<ObservedSourceValueV1>,
): EffectiveHistoryEntry[] => {
  const ordered = [...targetObservations].sort(byCompleted)
  const valueByObservation = new Map(bindingValues.map((v) => [v.source_observation_id, v] as const))
  // Newest successful value at or before each index.
  const carried: Array<ObservedSourceValueV1 | null> = []
  let running: ObservedSourceValueV1 | null = null
  for (const o of ordered) {
    if (isSuccessfulCollection(o.collection_state)) {
      const own = valueByObservation.get(o.id) ?? null
      if (own !== null) running = own
    }
    carried.push(isSuccessfulCollection(o.collection_state) ? running : null)
  }
  return ordered.map((o, i) => {
    if (!isSuccessfulCollection(o.collection_state)) {
      return {
        observation_id: o.id,
        completed_at: o.completed_at,
        collection_state: o.collection_state,
        state: "UNKNOWN",
        reason: "collection did not produce evidence",
        extracted_value: null,
      }
    }
    const value = carried[i] ?? null
    const finding = deriveFinding(fact, binding, o.id, value)
    return {
      observation_id: o.id,
      completed_at: o.completed_at,
      collection_state: o.collection_state,
      state: finding.state,
      reason: finding.reason,
      extracted_value: value?.extracted_value ?? null,
    }
  })
}
