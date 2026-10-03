// Product Surface V1 read model: DB repository -> representation domain
// derivation -> API DTO -> React. Domain (effective observation, finding,
// canonical citation match) lives here and in @ghostping/representation;
// React only renders. No scores, no causality, no publication claims.
import { Effect } from "effect"
import { buildGraph, deriveFinding, sameCanonicalUrl, type RepresentationFindingV1 } from "@ghostping/representation"
import { BusinessRepository, FactRepository, ProductReadRepository } from "@ghostping/db"

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

/** Full representation list for one business, findings via domain derivation. */
export const assembleRepresentationList = (rows: RepresentationRows): RepresentationRowDto[] => {
  const factById = new Map(rows.facts.map((f) => [f.id, f]))
  const targetById = new Map(rows.targets.map((t) => [t.id, t]))
  const obsByTarget = new Map<string, RowObservation[]>()
  for (const o of rows.observations) {
    const arr = obsByTarget.get(o.sourceTargetId) ?? []
    arr.push(o)
    obsByTarget.set(o.sourceTargetId, arr)
  }
  for (const arr of obsByTarget.values()) arr.sort((a, b) => a.completedAt.localeCompare(b.completedAt))
  const successfulByTarget = new Map<string, RowObservation>()
  for (const [tid, arr] of obsByTarget) {
    const ok = arr.filter((o) => o.collectionState === "FETCHED" || o.collectionState === "NOT_MODIFIED")
    if (ok.length > 0) successfulByTarget.set(tid, ok[ok.length - 1]!)
  }
  const valueByBindingObs = new Map(rows.values.map((v) => [`${v.sourceBindingId}|${v.sourceObservationId}`, v] as const))
  const out: RepresentationRowDto[] = []
  for (const b of rows.bindings) {
    const fact = factById.get(b.factId)
    const target = targetById.get(b.sourceTargetId)
    if (!fact || !target) continue
    const attempts = obsByTarget.get(target.id) ?? []
    const latest = attempts.length > 0 ? attempts[attempts.length - 1]! : null
    const effective = successfulByTarget.get(target.id) ?? null
    const value = effective ? (valueByBindingObs.get(`${b.id}|${effective.id}`) ?? null) : null
    const finding: RepresentationFindingV1 = deriveFinding(
      { id: fact.id, value_text: fact.valueText },
      {
        id: b.id,
        business_id: "",
        fact_id: fact.id,
        source_target_id: target.id,
        extractor: { kind: b.extractorKind as "JSON_LD" | "CSS_TEXT" | "META_CONTENT", selector: b.extractorSelector },
        comparator: b.comparator as "EXACT_TEXT" | "BOOLEAN" | "MONEY",
        created_at: "",
      },
      effective?.id ?? "",
      value
        ? {
            id: value.id,
            business_id: "",
            source_observation_id: value.sourceObservationId,
            source_binding_id: value.sourceBindingId,
            fact_id: value.factId,
            extracted_value: value.extractedValue,
            extraction_state: value.extractionState as "OBSERVED" | "NOT_FOUND" | "AMBIGUOUS" | "UNSUPPORTED" | "FAILED",
            evidence_locator: { selector: "", source_observation_id: value.sourceObservationId, node_identity: null },
            extractor_version: "",
            created_at: "",
          }
        : null,
    )
    out.push({
      binding_id: b.id,
      fact,
      source: { target_id: target.id, url: target.url, control: target.control },
      finding: { state: finding.state, reason: finding.reason },
      effective_observation:
        effective && value
          ? {
              observation_id: effective.id,
              completed_at: effective.completedAt,
              collection_state: effective.collectionState,
              extracted_value: value.extractedValue,
              extraction_state: value.extractionState,
            }
          : null,
      latest_attempt: latest
        ? { completed_at: latest.completedAt, collection_state: latest.collectionState, failure: latest.failure }
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
): Array<{ observation_id: string; completed_at: string; collection_state: string; state: string; reason: string; extracted_value: string | null }> => {
  const byObs = new Map(values.filter((v) => v.sourceBindingId === bindingId).map((v) => [v.sourceObservationId, v] as const))
  return observations
    .filter((o) => o.sourceTargetId === binding.sourceTargetId)
    .map((o) => {
      const v = byObs.get(o.id) ?? null
      const finding =
        o.collectionState === "FETCHED" || o.collectionState === "NOT_MODIFIED"
          ? deriveFinding(
              { id: fact.id, value_text: fact.valueText },
              {
                id: binding.id,
                business_id: "",
                fact_id: fact.id,
                source_target_id: binding.sourceTargetId,
                extractor: { kind: binding.extractorKind as "JSON_LD" | "CSS_TEXT" | "META_CONTENT", selector: binding.extractorSelector },
                comparator: binding.comparator as "EXACT_TEXT" | "BOOLEAN" | "MONEY",
                created_at: "",
              },
              o.id,
              v
                ? {
                    id: v.id,
                    business_id: "",
                    source_observation_id: v.sourceObservationId,
                    source_binding_id: v.sourceBindingId,
                    fact_id: v.factId,
                    extracted_value: v.extractedValue,
                    extraction_state: v.extractionState as "OBSERVED" | "NOT_FOUND" | "AMBIGUOUS" | "UNSUPPORTED" | "FAILED",
                    evidence_locator: { selector: "", source_observation_id: v.sourceObservationId, node_identity: null },
                    extractor_version: "",
                    created_at: "",
                  }
                : null,
            )
          : ({ state: "UNKNOWN", reason: "collection did not produce evidence" } as const)
      return {
        observation_id: o.id,
        completed_at: o.completedAt,
        collection_state: o.collectionState,
        state: finding.state,
        reason: finding.reason,
        extracted_value: v?.extractedValue ?? null,
      }
    })
}

export { buildGraph }

/** Scoped business or null (404 without leaking existence). */
const scopedBusiness = (accountId: string, businessId: string) =>
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
export const loadIssueDetail = (
  accountId: string,
  businessId: string,
  claimId: string,
  query: (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>,
) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const issue = yield* Effect.tryPromise({
      try: () =>
        query(
          `SELECT c.id AS claim_id, c.text AS claim_text, c.observation_id, o.answer_text, o.provider, o.observed_model, o.collected_at,
                  q.prompt AS question_prompt,
                  j.id AS judgment_id, j.verdict, j.notes,
                  COALESCE((SELECT json_agg(json_build_object('id', f.id, 'predicate', f.predicate, 'valueText', f.value_text, 'status', f.status) ORDER BY f.predicate)
                    FROM human_judgment_facts hjf JOIN authoritative_facts f ON f.id = hjf.fact_id WHERE hjf.judgment_id = j.id), '[]'::json) AS facts
           FROM candidate_claims c
           JOIN observations o ON o.id = c.observation_id
           LEFT JOIN check_runs cr ON cr.id = o.check_run_id
           LEFT JOIN buyer_questions q ON q.id = cr.question_id
           LEFT JOIN human_judgments j ON j.claim_id = c.id AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id)
           WHERE c.business_id = $1 AND c.id = $2`,
          [businessId, claimId],
        ),
      catch: () => ({ rows: [] }),
    })
    const row = issue.rows[0]
    if (!row) return null
    const verdict = row["verdict"] as string | null
    const state =
      verdict === "CONTRADICTED"
        ? "WRONG"
        : verdict === "PARTIAL"
          ? "PARTIAL"
          : verdict === "INSUFFICIENT_EVIDENCE"
            ? "UNKNOWN"
            : verdict === "SUPPORTED"
              ? "RESOLVED"
              : "NEEDS_REVIEW"
    const reads = yield* ProductReadRepository
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
