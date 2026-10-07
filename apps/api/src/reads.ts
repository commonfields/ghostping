// Product Surface V1 read model: DB repository -> representation domain
// derivation -> API DTO -> React. Domain (effective observation, finding,
// canonical citation match) lives here and in @openrecord/representation;
// React only renders. No scores, no causality, no publication claims.
import { Effect } from "effect"
import {
  buildGraph,
  resolveEffectiveEvidence,
  resolveHistory,
  sameCanonicalUrl,
  type ObservedSourceValueV1,
  type SourceBindingV1,
  type SourceObservationV1,
} from "@openrecord/representation"
import { BusinessRepository, FactRepository, ProductReadRepository } from "@openrecord/db"

export interface FactDto {
  readonly id: string
  readonly subject: string
  readonly predicate: string
  readonly valueText: string
  readonly valueType: string
  readonly status: string
  readonly version: number
}

export interface RepresentationRowDto {
  readonly binding_id: string
  readonly fact: FactDto
  readonly source: { readonly target_id: string; readonly url: string; readonly control: string }
  readonly finding: { readonly state: string; readonly reason: string }
  readonly effective_observation: {
    readonly observation_id: string
    readonly completed_at: string
    readonly collection_state: string
    readonly extracted_value: string | null
    readonly extraction_state: string
  } | null
  readonly latest_attempt: { readonly completed_at: string; readonly collection_state: string; readonly failure: string | null } | null
  /**
   * Newest FETCHED/NOT_MODIFIED check. May differ from both latest_attempt
   * (a later FAILED check) and effective_observation (a 304/unchanged
   * reuse carries no value row, so evidence comes from an older check).
   */
  readonly latest_successful_check: { readonly observation_id: string; readonly completed_at: string; readonly collection_state: string } | null
}

interface RowTarget {
  readonly id: string
  readonly url: string
  readonly control: string
}
interface RowBinding {
  readonly id: string
  readonly factId: string
  readonly sourceTargetId: string
  readonly extractorKind: string
  readonly extractorSelector: string
  readonly comparator: string
}
interface RowObservation {
  readonly id: string
  readonly sourceTargetId: string
  readonly completedAt: string
  readonly collectionState: string
  readonly failure: string | null
}
interface RowValue {
  readonly id: string
  readonly sourceObservationId: string
  readonly sourceBindingId: string
  readonly factId: string
  readonly extractedValue: string | null
  readonly extractionState: string
}

export interface RepresentationRows {
  readonly facts: ReadonlyArray<FactDto>
  readonly targets: ReadonlyArray<RowTarget>
  readonly bindings: ReadonlyArray<RowBinding>
  readonly observations: ReadonlyArray<RowObservation>
  readonly values: ReadonlyArray<RowValue>
}

const toDomainBinding = (b: RowBinding, factId: string): SourceBindingV1 => ({
  id: b.id,
  business_id: "",
  fact_id: factId,
  source_target_id: b.sourceTargetId,
  extractor: { kind: b.extractorKind as SourceBindingV1["extractor"]["kind"], selector: b.extractorSelector },
  comparator: b.comparator as SourceBindingV1["comparator"],
  created_at: "",
})

const toDomainObservation = (o: RowObservation): SourceObservationV1 => ({
  id: o.id,
  business_id: "",
  source_target_id: o.sourceTargetId,
  collector: "NATIVE_HTTP",
  collector_version: "",
  requested_url: "",
  final_url: "",
  started_at: o.completedAt,
  completed_at: o.completedAt,
  http_status: null,
  content_type: null,
  etag: null,
  last_modified: null,
  body_digest: null,
  body_bytes: 0,
  collection_state: o.collectionState as SourceObservationV1["collection_state"],
  failure: o.failure as SourceObservationV1["failure"],
  raw_evidence_id: null,
})

const toDomainValue = (v: RowValue): ObservedSourceValueV1 => ({
  id: v.id,
  business_id: "",
  source_observation_id: v.sourceObservationId,
  source_binding_id: v.sourceBindingId,
  fact_id: v.factId,
  extracted_value: v.extractedValue,
  extraction_state: v.extractionState as ObservedSourceValueV1["extraction_state"],
  evidence_locator: { selector: "", source_observation_id: v.sourceObservationId, node_identity: null },
  extractor_version: "",
  created_at: "",
})

/** Full representation list for one business, via the canonical resolver. */
export const assembleRepresentationList = (rows: RepresentationRows): RepresentationRowDto[] => {
  const factById = new Map(rows.facts.map((f) => [f.id, f]))
  const targetById = new Map(rows.targets.map((t) => [t.id, t]))
  const obsByTarget = new Map<string, RowObservation[]>()
  for (const o of rows.observations) {
    const arr = obsByTarget.get(o.sourceTargetId) ?? []
    arr.push(o)
    obsByTarget.set(o.sourceTargetId, arr)
  }
  const valuesByBinding = new Map<string, RowValue[]>()
  for (const v of rows.values) {
    const arr = valuesByBinding.get(v.sourceBindingId) ?? []
    arr.push(v)
    valuesByBinding.set(v.sourceBindingId, arr)
  }
  const out: RepresentationRowDto[] = []
  for (const b of rows.bindings) {
    const fact = factById.get(b.factId)
    const target = targetById.get(b.sourceTargetId)
    if (!fact || !target) continue
    // Same canonical semantics as buildGraph: never duplicated here.
    const evidence = resolveEffectiveEvidence(
      { id: fact.id, value_text: fact.valueText },
      toDomainBinding(b, fact.id),
      (obsByTarget.get(target.id) ?? []).map(toDomainObservation),
      (valuesByBinding.get(b.id) ?? []).map(toDomainValue),
    )
    const effective = evidence.effectiveValueObservation
    const value = evidence.effectiveValue
    const latest = evidence.latestAttempt
    const successful = evidence.latestSuccessfulCheck
    out.push({
      binding_id: b.id,
      fact,
      source: { target_id: target.id, url: target.url, control: target.control },
      finding: { state: evidence.finding.state, reason: evidence.finding.reason },
      effective_observation:
        effective && value
          ? {
              observation_id: effective.id,
              completed_at: effective.completed_at,
              collection_state: effective.collection_state,
              extracted_value: value.extracted_value,
              extraction_state: value.extraction_state,
            }
          : null,
      latest_attempt: latest
        ? { completed_at: latest.completed_at, collection_state: latest.collection_state, failure: latest.failure }
        : null,
      latest_successful_check: successful
        ? { observation_id: successful.id, completed_at: successful.completed_at, collection_state: successful.collection_state }
        : null,
    })
  }
  return out
}

export interface CitationEvidence {
  readonly uri: string
  readonly title: string | null
  readonly position: number | null
  readonly attributed: boolean
  readonly tracked: {
    readonly binding_id: string
    readonly target_id: string
    readonly url: string
    readonly control: string
    readonly observed_value: string | null
    readonly extraction_state: string | null
    readonly finding: string
    readonly finding_reason: string
    readonly observed_at: string | null
  } | null
}

/** Match stored citations to tracked targets (canonical URL); else untracked. */
export const assembleCitationEvidence = (
  citations: ReadonlyArray<{ uri: string | null; title: string | null; position: number | null; attributed: boolean }>,
  representations: ReadonlyArray<RepresentationRowDto>,
): CitationEvidence[] => {
  const out: CitationEvidence[] = []
  for (const c of citations) {
    if (c.uri === null) continue
    const match = representations.find((r) => sameCanonicalUrl(c.uri as string, r.source.url))
    out.push({
      uri: c.uri,
      title: c.title,
      position: c.position,
      attributed: c.attributed,
      tracked: match
        ? {
            binding_id: match.binding_id,
            target_id: match.source.target_id,
            url: match.source.url,
            control: match.source.control,
            observed_value: match.effective_observation?.extracted_value ?? null,
            extraction_state: match.effective_observation?.extraction_state ?? null,
            finding: match.finding.state,
            finding_reason: match.finding.reason,
            observed_at: match.effective_observation?.completed_at ?? null,
          }
        : null,
    })
  }
  return out
}

/** Per-observation finding history for one binding (derived, oldest first). */
export const findingHistoryForBinding = (
  bindingId: string,
  fact: FactDto,
  binding: RowBinding,
  observations: ReadonlyArray<RowObservation>,
  values: ReadonlyArray<RowValue>,
): Array<{ observation_id: string; completed_at: string; collection_state: string; state: string; reason: string; extracted_value: string | null }> =>
  resolveHistory(
    { id: fact.id, value_text: fact.valueText },
    toDomainBinding(binding, fact.id),
    observations.filter((o) => o.sourceTargetId === binding.sourceTargetId).map(toDomainObservation),
    values.filter((v) => v.sourceBindingId === bindingId).map(toDomainValue),
  )

export { buildGraph }

/** Verdict to inbox state (single rule for list and detail). */
export const issueStateOf = (verdict: string | null): string =>
  verdict === "CONTRADICTED"
    ? "WRONG"
    : verdict === "PARTIAL"
      ? "PARTIAL"
      : verdict === "INSUFFICIENT_EVIDENCE"
        ? "UNKNOWN"
        : verdict === "SUPPORTED"
          ? "RESOLVED"
          : "NEEDS_REVIEW"

export class FactLineageForked extends Error {
  readonly _tag = "FactLineageForked" as const
  constructor(detail?: string) {
    super(detail === undefined ? "FactLineageForked" : `FactLineageForked: ${detail}`)
  }
}

/**
 * Authority history follows supersedes_id lineage, never mutable
 * subject/predicate metadata. Returns versions oldest-first. Fails closed
 * on forks, cycles, or disconnected rows instead of flattening them.
 */
export const assertLinearLineage = (
  rows: ReadonlyArray<{ id: string; supersedes_id: string | null; version: number }>,
): Array<{ id: string; supersedes_id: string | null; version: number }> => {
  if (rows.length === 0) return []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const children = new Map<string, number>()
  for (const r of rows) {
    if (r.supersedes_id === null) continue
    if (r.supersedes_id === r.id) throw new FactLineageForked(`self-supersession ${r.id}`)
    if (!byId.has(r.supersedes_id)) throw new FactLineageForked(`dangling supersedes_id ${r.id}`)
    children.set(r.supersedes_id, (children.get(r.supersedes_id) ?? 0) + 1)
  }
  for (const [id, n] of children) {
    if (n > 1) throw new FactLineageForked(`fork at ${id}`)
  }
  const superseded = new Set(rows.flatMap((r) => (r.supersedes_id === null ? [] : [r.supersedes_id])))
  const heads = rows.filter((r) => !superseded.has(r.id))
  if (heads.length !== 1) throw new FactLineageForked(`heads: ${heads.length}`)
  const ordered: Array<{ id: string; supersedes_id: string | null; version: number }> = []
  const visited = new Set<string>()
  let cur: { id: string; supersedes_id: string | null; version: number } | undefined = heads[0]
  while (cur !== undefined) {
    if (visited.has(cur.id)) throw new FactLineageForked(`cycle at ${cur.id}`)
    visited.add(cur.id)
    ordered.push(cur)
    cur = cur.supersedes_id === null ? undefined : byId.get(cur.supersedes_id)
  }
  if (ordered.length !== rows.length) throw new FactLineageForked("disconnected")
  return [...ordered].reverse()
}

/** Scoped business or null (404 without leaking existence). */
export const scopedBusiness = (accountId: string, businessId: string) =>
  Effect.gen(function*() {
    const biz = yield* BusinessRepository
    return yield* biz.getScoped(accountId, businessId)
  })

const toFactDto = (r: { id: string; subject: string; predicate: string; valueText: string; valueType: string; status: string; version: number }): FactDto => ({
  id: r.id,
  subject: r.subject,
  predicate: r.predicate,
  valueText: r.valueText,
  valueType: r.valueType,
  status: r.status,
  version: r.version,
})

const loadRows = (businessId: string) =>
  Effect.gen(function*() {
    const reads = yield* ProductReadRepository
    const factsRepo = yield* FactRepository
    const [facts, targets, bindings, observations, values] = yield* Effect.all([
      factsRepo.listByBusiness(businessId),
      reads.targets(businessId),
      reads.bindings(businessId),
      reads.observations(businessId),
      reads.values(businessId),
    ])
    return {
      facts: facts.map((f) => toFactDto({ id: f.id, subject: f.subject, predicate: f.predicate, valueText: f.valueText, valueType: f.valueType, status: f.status, version: f.version })),
      targets: targets.map((t) => ({ id: t.id, url: t.url, control: t.control })),
      bindings: bindings.map((b) => ({ id: b.id, factId: b.factId, sourceTargetId: b.sourceTargetId, extractorKind: b.extractorKind, extractorSelector: b.extractorSelector, comparator: b.comparator })),
      observations: observations.map((o) => ({ id: o.id, sourceTargetId: o.sourceTargetId, completedAt: o.completedAt, collectionState: o.collectionState, failure: o.failure })),
      values: values.map((v) => ({ id: v.id, sourceObservationId: v.sourceObservationId, sourceBindingId: v.sourceBindingId, factId: v.factId, extractedValue: v.extractedValue, extractionState: v.extractionState })),
    }
  })

/** Authenticated representation list for one business. */
export const loadRepresentations = (accountId: string, businessId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    return assembleRepresentationList(yield* loadRows(businessId))
  })

/** Issue detail: claim + observation context + truth + citation evidence. */
export const loadIssueDetail = (accountId: string, businessId: string, claimId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const reads = yield* ProductReadRepository
    const row = yield* reads.issueDetailRow(businessId, claimId)
    if (!row) return null
    const verdict = row["verdict"] as string | null
    const state = issueStateOf(verdict)
    const rows = yield* loadRows(businessId)
    const representations = assembleRepresentationList(rows)
    const citations = yield* reads.aiCitations(businessId)
    const own = citations.filter((c) => String(c["observation_id"]) === String(row["observation_id"]))
    const citation_evidence = assembleCitationEvidence(
      own.map((c) => ({
        uri: (c["uri"] as string | null) ?? null,
        title: (c["title"] as string | null) ?? null,
        position: (c["position"] as number | null) ?? null,
        attributed: Boolean(c["attributed"]),
      })),
      representations,
    )
    return { ...row, state, citation_evidence }
  })
export const citationEvidenceForObservation = (accountId: string, businessId: string, observationId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const reads = yield* ProductReadRepository
    const rows = yield* loadRows(businessId)
    const representations = assembleRepresentationList(rows)
    const citations = (yield* reads.aiCitations(businessId)).filter((c) => String(c["observation_id"]) === observationId)
    return assembleCitationEvidence(
      citations.map((c) => ({
        uri: (c["uri"] as string | null) ?? null,
        title: (c["title"] as string | null) ?? null,
        position: (c["position"] as number | null) ?? null,
        attributed: Boolean(c["attributed"]),
      })),
      representations,
    )
  })
export const loadRepresentationDetail = (accountId: string, businessId: string, bindingId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const reads = yield* ProductReadRepository
    const binding = yield* reads.binding(businessId, bindingId)
    if (!binding) return null
    const rows = yield* loadRows(businessId)
    const list = assembleRepresentationList(rows)
    const current = list.find((r) => r.binding_id === bindingId) ?? null
    const fact = rows.facts.find((f) => f.id === binding.factId) ?? null
    const target = rows.targets.find((t) => t.id === binding.sourceTargetId) ?? null
    if (!fact || !target) return null
    const history = findingHistoryForBinding(
      binding.id,
      fact,
      { id: binding.id, factId: binding.factId, sourceTargetId: binding.sourceTargetId, extractorKind: binding.extractorKind, extractorSelector: binding.extractorSelector, comparator: binding.comparator },
      rows.observations,
      rows.values,
    )
    const citations = yield* reads.aiCitations(businessId)
    const matched = citations
      .filter((c) => typeof c["uri"] === "string" && c["uri"] !== null && sameCanonicalUrl(c["uri"] as string, target.url))
      .map((c) => ({
        uri: c["uri"] as string,
        title: (c["title"] as string | null) ?? null,
        observation_id: String(c["observation_id"]),
        claim_id: (c["claim_id"] as string | null) ?? null,
        claim_text: (c["claim_text"] as string | null) ?? null,
        provider: String(c["provider"] ?? ""),
        observed_model: (c["observed_model"] as string | null) ?? null,
        collected_at: String(c["collected_at"] ?? ""),
      }))
    return { binding, fact, source: { target_id: target.id, url: target.url, control: target.control }, current, history, citations: matched }
  })