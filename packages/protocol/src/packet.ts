// Evidence packet assembly, sealing, and fail-closed validation.
//
// `assembleEvidencePacket` is the only producer of derived packet fields
// (issue state, signatures, match, change, outcome, unknowns, synthetic).
// `validatePacket` re-runs assembly over the packet's own evidence and
// rejects any packet whose derived fields or ordering disagree.
import { Schema } from "effect"
import { canonicalJson, compareCodePoints, sha256 } from "./canonical.js"
import {
  byTimeThenId,
  compareMeasurements,
  deriveObservedChange,
  deriveOutcome,
  latestJudgment,
  measurementSignature,
  soleClaim,
} from "./measurement.js"
import {
  EvidencePacketV1,
  PROTOCOL_VERSION,
  schemaId,
  type ClaimV1,
  type ExplicitUnknownV1,
  type FactV1,
  type InterventionV1,
  type IssueState,
  type JudgmentV1,
  type KnowledgeString,
  type ObservationV1,
  type ReobservationV1,
  type UnsealedEvidencePacketV1,
  type Verdict,
} from "./schema.js"

export class EvidencePacketInvalid extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(detail === undefined ? `EvidencePacketInvalid: ${reason}` : `EvidencePacketInvalid: ${reason}: ${detail}`)
  }
}

export const issueStateFor = (verdict: Verdict | null): IssueState => {
  switch (verdict) {
    case null:
      return "NEEDS_REVIEW"
    case "CONTRADICTED":
      return "WRONG"
    case "PARTIAL":
      return "PARTIAL"
    case "INSUFFICIENT_EVIDENCE":
      return "UNKNOWN"
    case "SUPPORTED":
      return "RESOLVED"
  }
}

export interface ReobservationInput {
  readonly id: string
  readonly intervention_id: string | null
  readonly created_at: string
  readonly observation: ObservationV1
  readonly claims: ReadonlyArray<ClaimV1>
  readonly judgments: ReadonlyArray<JudgmentV1>
}

export interface PacketInput {
  readonly id: string
  readonly business: { readonly id: string; readonly name: string }
  readonly issue: { readonly id: string; readonly type: KnowledgeString; readonly created_at: string }
  readonly issue_claim_id: string
  readonly facts: ReadonlyArray<FactV1>
  readonly original_observation: ObservationV1
  readonly claims: ReadonlyArray<ClaimV1>
  readonly judgments: ReadonlyArray<JudgmentV1>
  readonly interventions: ReadonlyArray<InterventionV1>
  readonly reobservations: ReadonlyArray<ReobservationInput>
  readonly generated_at: string
}

const cmp = compareCodePoints
const factOrder = (a: FactV1, b: FactV1) =>
  cmp(a.subject, b.subject) || cmp(a.predicate, b.predicate) || a.version - b.version || cmp(a.id, b.id)
const interventionOrder = (a: InterventionV1, b: InterventionV1) =>
  cmp(a.performed_at, b.performed_at) || cmp(a.created_at, b.created_at) || cmp(a.id, b.id)

const SURFACE_KNOWLEDGE_FIELDS = [
  "gateway",
  "requested_provider",
  "requested_model",
  "observed_provider",
  "observed_model",
  "account_state",
  "subscription_tier",
  "locale",
  "region",
  "search_mode",
  "personalization_state",
] as const

const observationUnknowns = (o: ObservationV1): Array<ExplicitUnknownV1> => {
  const out: Array<ExplicitUnknownV1> = []
  for (const field of SURFACE_KNOWLEDGE_FIELDS) {
    if (o.measurement.surface[field].state === "UNKNOWN") out.push({ subject_id: o.id, field: `surface.${field}` })
  }
  if (o.measurement.question_version.state === "UNKNOWN") out.push({ subject_id: o.id, field: "measurement.question_version" })
  if (o.measurement.measurement_configuration.state === "UNKNOWN") {
    out.push({ subject_id: o.id, field: "measurement.measurement_configuration" })
  }
  if (o.measurement.repeat_id.state === "UNKNOWN") out.push({ subject_id: o.id, field: "measurement.repeat_id" })
  if (o.provider_metadata.state === "UNKNOWN") out.push({ subject_id: o.id, field: "provider_metadata" })
  return out
}

const isSynthetic = (o: ObservationV1): boolean => {
  if (o.measurement.surface.kind === "MOCK" && !o.synthetic) {
    throw new EvidencePacketInvalid("MockObservationNotSynthetic", o.id)
  }
  return o.synthetic
}

export const assembleEvidencePacket = (input: PacketInput): UnsealedEvidencePacketV1 => {
  const original = input.original_observation
  const claims = [...input.claims].sort(byTimeThenId)
  const judgments = [...input.judgments].sort(byTimeThenId)
  const interventions = [...input.interventions].sort(interventionOrder)
  const reInputs = [...input.reobservations].sort(byTimeThenId)

  const beforeJudgment = latestJudgment(judgments, input.issue_claim_id)
  const beforeSignature = measurementSignature(original.measurement)
  const unknowns: Array<ExplicitUnknownV1> = [...observationUnknowns(original)]
  if (input.issue.type.state === "UNKNOWN") unknowns.push({ subject_id: input.issue.id, field: "issue.type" })
  if (beforeJudgment === null) unknowns.push({ subject_id: input.issue.id, field: "verdict" })

  for (const i of interventions) {
    if (i.actor === "UNKNOWN") unknowns.push({ subject_id: i.id, field: "actor" })
    if (i.actor_id.state === "UNKNOWN") unknowns.push({ subject_id: i.id, field: "actor_id" })
    if (i.evidence_before_digest.state === "UNKNOWN") unknowns.push({ subject_id: i.id, field: "evidence_before_digest" })
    if (i.evidence_after_digest.state === "UNKNOWN") unknowns.push({ subject_id: i.id, field: "evidence_after_digest" })
  }

  const reobservations: Array<ReobservationV1> = []
  const reClaims: Array<ClaimV1> = []
  const reJudgments: Array<JudgmentV1> = []
  for (const r of reInputs) {
    const after = r.observation
    const afterSignature = measurementSignature(after.measurement)
    const match = compareMeasurements(beforeSignature, afterSignature)
    const afterClaim = soleClaim(r.claims, after.id)
    const afterJudgment = afterClaim === null ? null : latestJudgment(r.judgments, afterClaim.id)
    const change = deriveObservedChange(match, original.normalized_answer_text, after.normalized_answer_text)
    const beforeVerdict = beforeJudgment?.verdict ?? null
    const afterVerdict = afterJudgment?.verdict ?? null
    reobservations.push({
      schema: schemaId.reobservation,
      schema_version: PROTOCOL_VERSION,
      id: r.id,
      business_id: input.business.id,
      original_observation_id: original.id,
      issue_id: input.issue.id,
      intervention_id: r.intervention_id,
      observation_id: after.id,
      before_signature: beforeSignature,
      after_signature: afterSignature,
      match_classification: match,
      before_judgment_id: beforeJudgment?.id ?? null,
      after_claim_id: afterClaim?.id ?? null,
      after_judgment_id: afterJudgment?.id ?? null,
      before_verdict: beforeVerdict,
      after_verdict: afterVerdict,
      observed_change: change,
      outcome: deriveOutcome(beforeVerdict, afterVerdict, match, change),
      causal_attribution: "UNKNOWN",
      created_at: r.created_at,
    })
    reClaims.push(...r.claims)
    reJudgments.push(...r.judgments)
    unknowns.push(...observationUnknowns(after))
    if (afterClaim === null) unknowns.push({ subject_id: r.id, field: "after_claim" })
    else if (afterJudgment === null) unknowns.push({ subject_id: r.id, field: "after_verdict" })
  }

  if (interventions.length > 0 && reobservations.length === 0) {
    unknowns.push({ subject_id: input.issue.id, field: "outcome_after_intervention" })
  }
  if (interventions.length > 0 || reobservations.length > 0) {
    unknowns.push({ subject_id: input.issue.id, field: "causal_attribution" })
  }

  const observations = [original, ...reInputs.map((r) => r.observation)]
  const synthetic = observations.map(isSynthetic).some(Boolean)

  return {
    schema: schemaId.packet,
    schema_version: PROTOCOL_VERSION,
    id: input.id,
    business: { id: input.business.id, name: input.business.name },
    issue: {
      schema: schemaId.issue,
      schema_version: PROTOCOL_VERSION,
      id: input.issue.id,
      business_id: input.business.id,
      observation_id: original.id,
      claim_id: input.issue_claim_id,
      type: input.issue.type,
      state: issueStateFor(beforeJudgment?.verdict ?? null),
      derived_from_judgment_id: beforeJudgment?.id ?? null,
      created_at: input.issue.created_at,
    },
    facts: [...input.facts].sort(factOrder),
    original_observation: original,
    claims,
    judgments,
    interventions,
    reobservations,
    reobservation_observations: reInputs.map((r) => r.observation),
    reobservation_claims: reClaims.sort(byTimeThenId),
    reobservation_judgments: reJudgments.sort(byTimeThenId),
    observed_outcome: reobservations.at(-1)?.outcome ?? "NOT_OBSERVED",
    causal_attribution: "UNKNOWN",
    explicit_unknowns: unknowns,
    synthetic,
    generated_at: input.generated_at,
    signatures: [],
  }
}

/** SHA-256 over canonical bytes of the packet without `packet_digest`. */
export const packetDigest = (packet: UnsealedEvidencePacketV1 | EvidencePacketV1): string => {
  const { packet_digest: _ignored, ...unsealed } = packet as EvidencePacketV1
  return sha256(canonicalJson(unsealed))
}

export const sealPacket = (packet: UnsealedEvidencePacketV1): EvidencePacketV1 => ({
  ...packet,
  packet_digest: packetDigest(packet),
})

export const exportEvidencePacket = (input: PacketInput): EvidencePacketV1 => sealPacket(assembleEvidencePacket(input))

/** Deterministic packet bytes: canonical JSON of the sealed packet. */
export const serializePacket = (packet: EvidencePacketV1): string => canonicalJson(packet)

const requireAll = (cond: boolean, reason: string, detail?: string) => {
  if (!cond) throw new EvidencePacketInvalid(reason, detail)
}
const uniqueIds = (items: ReadonlyArray<{ id: string }>, what: string) =>
  requireAll(new Set(items.map((i) => i.id)).size === items.length, "DuplicateId", what)

const checkReferences = (p: EvidencePacketV1): void => {
  const biz = p.business.id
  const observations = [p.original_observation, ...p.reobservation_observations]
  const owned: ReadonlyArray<{ business_id: string; id: string }> = [
    p.issue, ...p.facts, ...observations, ...p.claims, ...p.judgments, ...p.interventions,
    ...p.reobservations, ...p.reobservation_claims, ...p.reobservation_judgments,
  ]
  for (const o of owned) requireAll(o.business_id === biz, "CrossTenantReference", o.id)
  for (const o of observations) requireAll(o.measurement.business_id === biz, "CrossTenantReference", o.id)

  uniqueIds(p.facts, "facts")
  uniqueIds(observations, "observations")
  uniqueIds([...p.claims, ...p.reobservation_claims], "claims")
  uniqueIds([...p.judgments, ...p.reobservation_judgments], "judgments")
  uniqueIds(p.interventions, "interventions")
  uniqueIds(p.reobservations, "reobservations")

  const factIds = new Set(p.facts.map((f) => f.id))
  const claimIds = new Set(p.claims.map((c) => c.id))
  const reClaimIds = new Set(p.reobservation_claims.map((c) => c.id))
  const reObsIds = new Set(p.reobservation_observations.map((o) => o.id))
  const interventionIds = new Set(p.interventions.map((i) => i.id))

  requireAll(p.issue.observation_id === p.original_observation.id, "DanglingReference", "issue.observation_id")
  requireAll(claimIds.has(p.issue.claim_id), "DanglingReference", "issue.claim_id")
  for (const c of p.claims) requireAll(c.observation_id === p.original_observation.id, "DanglingReference", c.id)
  for (const c of p.reobservation_claims) requireAll(reObsIds.has(c.observation_id), "DanglingReference", c.id)
  const checkJudgments = (js: ReadonlyArray<JudgmentV1>, owners: Set<string>) => {
    for (const j of js) {
      requireAll(owners.has(j.claim_id), "DanglingReference", j.id)
      for (const f of j.fact_ids) requireAll(factIds.has(f), "DanglingReference", `${j.id}.fact_ids`)
      if (j.supersedes_id !== null) {
        requireAll(js.some((o) => o.id === j.supersedes_id && o.claim_id === j.claim_id), "DanglingReference", `${j.id}.supersedes_id`)
      }
    }
  }
  checkJudgments(p.judgments, claimIds)
  checkJudgments(p.reobservation_judgments, reClaimIds)
  for (const f of p.facts) {
    if (f.supersedes_id !== null) requireAll(factIds.has(f.supersedes_id), "DanglingReference", `${f.id}.supersedes_id`)
  }
  for (const i of p.interventions) {
    requireAll(i.issue_ids.includes(p.issue.id), "DanglingReference", `${i.id}.issue_ids`)
    if (i.supersedes_id !== null) requireAll(interventionIds.has(i.supersedes_id), "DanglingReference", `${i.id}.supersedes_id`)
    requireAll((i.supersedes_id === null) === (i.correction_reason === null), "InvalidCorrection", i.id)
  }
  requireAll(p.reobservations.length === p.reobservation_observations.length, "DanglingReference", "reobservation_observations")
  p.reobservations.forEach((r, index) => {
    requireAll(r.observation_id === p.reobservation_observations[index]?.id, "DanglingReference", `${r.id}.observation_id`)
    requireAll(r.intervention_id === null || interventionIds.has(r.intervention_id), "DanglingReference", `${r.id}.intervention_id`)
  })
}

/** Fail-closed reader: schema/version, digest, references, then full
 * re-derivation of every derived field. Never imports into a database. */
export const validatePacket = (input: unknown): EvidencePacketV1 => {
  const head = input as { schema?: unknown; schema_version?: unknown } | null
  if (typeof head !== "object" || head === null) throw new EvidencePacketInvalid("NotAnObject")
  if (head.schema !== schemaId.packet || head.schema_version !== PROTOCOL_VERSION) {
    throw new EvidencePacketInvalid("UnsupportedSchemaVersion", `${String(head.schema)}@${String(head.schema_version)}`)
  }
  let packet: EvidencePacketV1
  try {
    packet = Schema.decodeUnknownSync(EvidencePacketV1, { onExcessProperty: "error" })(input)
  } catch (e) {
    throw new EvidencePacketInvalid("SchemaViolation", e instanceof Error ? e.message.split("\n")[0] : undefined)
  }
  if (packetDigest(packet) !== packet.packet_digest) throw new EvidencePacketInvalid("DigestMismatch")
  checkReferences(packet)
  const rederived = assembleEvidencePacket({
    id: packet.id,
    business: packet.business,
    issue: packet.issue,
    issue_claim_id: packet.issue.claim_id,
    facts: packet.facts,
    original_observation: packet.original_observation,
    claims: packet.claims,
    judgments: packet.judgments,
    interventions: packet.interventions,
    reobservations: packet.reobservations.map((r, index) => {
      const observation = packet.reobservation_observations[index] as ObservationV1
      const claims = packet.reobservation_claims.filter((c) => c.observation_id === observation.id)
      const ids = new Set(claims.map((c) => c.id))
      return {
        id: r.id,
        intervention_id: r.intervention_id,
        created_at: r.created_at,
        observation,
        claims,
        judgments: packet.reobservation_judgments.filter((j) => ids.has(j.claim_id)),
      }
    }),
    generated_at: packet.generated_at,
  })
  const { packet_digest: _d, ...unsealed } = packet
  if (canonicalJson(rederived) !== canonicalJson(unsealed)) throw new EvidencePacketInvalid("DerivationMismatch")
  return packet
}
