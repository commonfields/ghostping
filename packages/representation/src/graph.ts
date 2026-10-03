// Representation graph query over relational rows (no graph database).
// Citation association uses conservative canonical URL matching and
// creates only CITED edges — never CAUSED_BY.

import { deriveFinding } from "./evaluate.js"
import { sameCanonicalUrl } from "./url.js"
import type {
  AiCitationEdge,
  FactRepresentationGraph,
  ObservedSourceValueV1,
  RepresentationFindingV1,
  SourceBindingV1,
  SourceObservationV1,
  SourceTargetV1,
} from "./types.js"

export interface GraphRows {
  readonly fact: { readonly id: string; readonly value_text: string; readonly value_type: string }
  readonly targets: ReadonlyArray<SourceTargetV1>
  readonly bindings: ReadonlyArray<SourceBindingV1>
  readonly observations: ReadonlyArray<SourceObservationV1>
  readonly values: ReadonlyArray<ObservedSourceValueV1>
  readonly aiCitations: ReadonlyArray<{ readonly observation_id: string; readonly claim_id: string | null; readonly uri: string | null }>
}

export const latestObservationByTarget = (
  observations: ReadonlyArray<SourceObservationV1>,
): Map<string, SourceObservationV1> => {
  const byTarget = new Map<string, SourceObservationV1[]>()
  for (const o of observations) {
    const arr = byTarget.get(o.source_target_id) ?? []
    arr.push(o)
    byTarget.set(o.source_target_id, arr)
  }
  const out = new Map<string, SourceObservationV1>()
  for (const [targetId, arr] of byTarget) {
    arr.sort((a, b) => a.completed_at.localeCompare(b.completed_at) || a.id.localeCompare(b.id))
    out.set(targetId, arr[arr.length - 1]!)
  }
  return out
}

/** Latest successful (FETCHED/NOT_MODIFIED) observation per target; failures never replace valid evidence. */
export const latestSuccessfulByTarget = (
  observations: ReadonlyArray<SourceObservationV1>,
): Map<string, SourceObservationV1> => {
  const ok = observations.filter((o) => o.collection_state === "FETCHED" || o.collection_state === "NOT_MODIFIED")
  return latestObservationByTarget(ok)
}

export const buildGraph = (rows: GraphRows): FactRepresentationGraph => {
  const latest = latestObservationByTarget(rows.observations)
  const valuesByBindingObs = new Map<string, ObservedSourceValueV1>()
  for (const v of rows.values) {
    valuesByBindingObs.set(`${v.source_binding_id}|${v.source_observation_id}`, v)
  }
  const findings: RepresentationFindingV1[] = []
  for (const b of rows.bindings) {
    const obs = [...latest.values()].find((o) => {
      // Binding → target → latest observation for that target.
      const targetOfBinding = b.source_target_id
      return o.source_target_id === targetOfBinding
    })
    if (!obs) {
      findings.push({
        fact_id: rows.fact.id,
        source_binding_id: b.id,
        source_observation_id: "",
        observed_value_id: null,
        state: "UNKNOWN",
        reason: "no observation yet",
      })
      continue
    }
    const value = valuesByBindingObs.get(`${b.id}|${obs.id}`) ?? null
    findings.push(deriveFinding(rows.fact, b, obs.id, value))
  }
  void latest
  const citation_edges: AiCitationEdge[] = []
  for (const c of rows.aiCitations) {
    if (c.uri === null) continue
    for (const t of rows.targets) {
      if (sameCanonicalUrl(c.uri, t.url)) {
        citation_edges.push({
          observation_id: c.observation_id,
          claim_id: c.claim_id,
          citation_uri: c.uri,
          source_target_id: t.id,
          edge: "CITED",
        })
      }
    }
  }
  return {
    fact: rows.fact,
    targets: rows.targets,
    bindings: rows.bindings,
    observations: rows.observations,
    values: rows.values,
    findings,
    citation_edges,
  }
}
