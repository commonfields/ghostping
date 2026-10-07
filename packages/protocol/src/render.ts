// Deterministic controlled-language view of an evidence packet.
//
// Plain application code; no LLM. Short sentences, one fact per sentence,
// active voice, fixed terminology, explicit unknowns. Inspired by controlled
// language practice; OpenRecord makes no ASD-STE100 compliance claim.
//
// This is a disposable view: the packet is the evidence.
import { factsAt } from "./measurement.js"
import type { EvidencePacketV1, FactV1, JudgmentV1, ObservationV1, SurfaceKind, Verdict } from "./schema.js"

const SURFACE_LABEL: Record<SurfaceKind, string> = {
  CONSUMER_UI: "a consumer user interface",
  DIRECT_API: "a direct provider API",
  ROUTER_API: "a router API",
  SEARCH_GROUNDED_API: "a search-grounded API",
  LOCAL_MODEL: "a local model",
  MOCK: "a synthetic mock surface",
}

const VERDICT_SENTENCE: Record<Verdict, string> = {
  SUPPORTED: "The approved value supports the claim.",
  CONTRADICTED: "The claim and the approved value conflict.",
  PARTIAL: "The approved value supports only part of the claim.",
  INSUFFICIENT_EVIDENCE: "The reviewer did not have enough evidence to decide.",
}

const surfaceSentence = (o: ObservationV1): string =>
  `OpenRecord measured ${o.measurement.surface.product}, ${SURFACE_LABEL[o.measurement.surface.kind]}.`

const factSentences = (packet: EvidencePacketV1, judgment: JudgmentV1, observedAt: string): Array<string> => {
  const lines: Array<string> = []
  const valid = new Set(factsAt(packet.facts, observedAt).map((f) => f.id))
  for (const id of judgment.fact_ids) {
    const fact = packet.facts.find((f) => f.id === id) as FactV1
    lines.push(`The approved ${fact.predicate} for ${fact.subject} was "${fact.value_text}" in fact version ${fact.version}.`)
    if (!valid.has(id)) lines.push(`Fact version ${fact.version} was not valid when the AI produced this response.`)
  }
  return lines
}

export const renderEvidencePacket = (packet: EvidencePacketV1): string => {
  const lines: Array<string> = []
  const original = packet.original_observation
  lines.push(
    packet.synthetic
      ? "SYNTHETIC DATA. This packet contains synthetic test evidence. It is not a production observation."
      : "This packet contains production evidence.",
  )
  lines.push(surfaceSentence(original))
  lines.push(`The question was "${original.measurement.question}".`)

  const claim = packet.claims.find((c) => c.id === packet.issue.claim_id)
  if (claim) lines.push(`The AI response contained the claim "${claim.text}".`)
  const before = packet.judgments.find((j) => j.id === packet.issue.derived_from_judgment_id)
  if (before) {
    lines.push(...factSentences(packet, before, original.measurement.observed_at))
    lines.push(`A reviewer judged the claim ${before.verdict}.`)
    lines.push(VERDICT_SENTENCE[before.verdict])
  } else {
    lines.push("No reviewer has judged the claim.")
  }

  const cited = original.citations.filter((c) => c.uri !== null)
  if (cited.length === 0) lines.push("The AI response returned no citations.")
  for (const c of cited) lines.push(`The AI response cited ${c.uri}.`)
  if (cited.length > 0 && before && before.verdict !== "SUPPORTED") {
    lines.push("OpenRecord cannot prove that a citation caused the response.")
  }

  for (const i of packet.interventions) {
    lines.push(`An operator recorded ${i.type} for ${i.target} at ${i.performed_at}.`)
    if (i.supersedes_id !== null) lines.push(`This record corrects intervention ${i.supersedes_id}.`)
    lines.push(i.actor === "UNKNOWN" ? "OpenRecord does not know who performed this action." : `The actor type was ${i.actor}.`)
  }
  if (packet.interventions.length > 0 && packet.reobservations.length === 0) {
    lines.push("OpenRecord has not observed an outcome after the intervention.")
  }

  packet.reobservations.forEach((r, index) => {
    const after = packet.reobservation_observations[index] as ObservationV1
    lines.push(`A later measurement was ${r.match_classification}.`)
    if (r.match_classification === "NOT_COMPARABLE") lines.push("The later measurement does not support a comparison.")
    if (r.match_classification === "INDETERMINATE") lines.push("Hidden measurement conditions prevent a comparison.")
    const afterClaim = packet.reobservation_claims.find((c) => c.id === r.after_claim_id)
    if (afterClaim) lines.push(`The later AI response contained the claim "${afterClaim.text}".`)
    const afterJudgment = packet.reobservation_judgments.find((j) => j.id === r.after_judgment_id)
    if (afterJudgment) {
      lines.push(...factSentences(packet, afterJudgment, after.measurement.observed_at))
      lines.push(`A reviewer judged the later claim ${afterJudgment.verdict}.`)
      if (before && before.fact_ids.join() !== afterJudgment.fact_ids.join()) {
        lines.push("The two judgments used different fact versions.")
      }
    } else {
      lines.push("No reviewer has judged the later response.")
    }
    lines.push(`The observed outcome was ${r.outcome}.`)
    if (r.outcome === "OBSERVED_CORRECTION" || r.outcome === "OBSERVED_REGRESSION") {
      const prefix = r.intervention_id === null ? "Later" : `After intervention ${r.intervention_id}`
      const kind = r.match_classification === "EXACT_MATCH" ? "an exactly matched" : "a comparable"
      lines.push(`${prefix}, ${kind} re-observation changed from ${r.before_verdict} to ${r.after_verdict}.`)
    }
  })
  if (packet.interventions.length > 0 || packet.reobservations.length > 0) {
    lines.push("Causal attribution is UNKNOWN.")
    lines.push("OpenRecord does not know whether any intervention caused a later response.")
  }
  for (const u of packet.explicit_unknowns) {
    if (u.field === "causal_attribution" || u.field === "outcome_after_intervention") continue
    lines.push(`OpenRecord does not know ${u.field} for ${u.subject_id}.`)
  }
  return lines.join("\n")
}
