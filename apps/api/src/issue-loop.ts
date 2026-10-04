// Issue-loop read model: one derived issue → action → recheck view.
//
// Everything here is derived at read time from existing repositories (the
// EvidenceLineageRepository snapshot, tracked source evidence from
// ProductReadRepository, and the representation list). Nothing is written,
// no tables are created, and no verification state is stored: source
// verification and the before/after comparison are recomputed on every
// request, so there is exactly one implementation of the comparison rules
// (the callers below delegate to @ghostping/protocol and never restate
// them).
//
// Vocabulary guard: responses describe what was observed, never why it
// happened. The only outcome sentences allowed are LOOP_DISPLAY_COPY.
import { Effect, Schema } from "effect"
import {
  compareMeasurements,
  deriveObservedChange,
  deriveOutcome,
  latestJudgment,
  measurementSignature,
  PROTOCOL_VERSION,
  schemaId,
  soleClaim,
  surfaceForWorker,
  UNKNOWN,
  knownValue,
  MeasurementContextV1,
  type ClaimV1,
  type JudgmentV1,
  type MatchClassification,
  type ObservedChange,
  type ObservedOutcome,
  type Verdict,
} from "@ghostping/protocol"
import { compareBoolean, compareExactText, compareMoney } from "@ghostping/representation"
import {
  CheckRunRepository,
  EvidenceLineageRepository,
  InterventionBindingRepository,
  ObservationRepository,
  ProductReadRepository,
  ReobservationIntentRepository,
  hostedQuestionVersion,
  type CheckRunRow,
  type InterventionRow,
  type ReobservationIntentRow,
  type ReobservationRow,
} from "@ghostping/db"
import { issueStateOf, loadRepresentations, scopedBusiness } from "./reads.js"

// ---------------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------------

/** Source verification states for one issue. Derived, never asserted. */
export type SourceChangeState =
  | "SOURCE_NOT_CHECKED"
  | "SOURCE_CHANGED"
  | "SOURCE_UNCHANGED"
  | "SOURCE_OBSERVATION_FAILED"
  | "SOURCE_UNKNOWN"

/** Current agreement between latest tracked evidence and approved truth. */
export type SourceAlignmentState = "IN_SYNC" | "DRIFT" | "UNKNOWN"

/**
 * The only outcome sentences the loop may render. Every display string in
 * the DTO comes from this map, so responses stay free of wording about
 * what brought an outcome about.
 */
export const LOOP_DISPLAY_COPY = {
  changed: "AI answer changed afterward",
  noChange: "No representation change observed",
  incomparable: "Not enough comparable evidence",
  notRechecked: "Not rechecked yet",
  needsReview: "Needs review",
} as const

const SOURCE_DETAIL: Record<SourceChangeState, string> = {
  SOURCE_NOT_CHECKED: "No action has been recorded for this issue, so there is no source follow-up to report.",
  SOURCE_UNKNOWN: "The source state cannot be established from tracked evidence, so it stays unknown.",
  SOURCE_CHANGED: "Tracked source evidence differs across the recorded action.",
  SOURCE_UNCHANGED: "Tracked source evidence is equivalent across the recorded action.",
  SOURCE_OBSERVATION_FAILED: "The linked source observation failed to collect, so the source state is unknown.",
}

export const SOURCE_ALIGNMENT_COPY: Record<SourceAlignmentState, string> = {
  IN_SYNC: "Current source state: in sync with approved truth",
  DRIFT: "Current source state: differs from approved truth",
  UNKNOWN: "Current source state: unknown",
}

// ---------------------------------------------------------------------------
// Pure inputs (plain data, so tests stay DB-free)
// ---------------------------------------------------------------------------

export interface LoopObservationInput {
  readonly id: string
  readonly businessId: string
  readonly checkRunId: string | null
  readonly questionId: string | null
  readonly questionPrompt: string | null
  readonly provider: string
  readonly requestedModel: string | null
  readonly observedModel: string | null
  readonly collectedAt: string
  readonly answerText: string
  readonly citations: ReadonlyArray<{
    readonly uri: string | null
    readonly title: string | null
    readonly position: number | null
    readonly attributed: boolean
  }>
  /** Stored measurement_context JSON, or null for rows that predate it. */
  readonly measurementContext: unknown
}

export interface LoopClaimInput {
  readonly id: string
  readonly observationId: string
  readonly text: string
  readonly createdAt: string
}

export interface LoopJudgmentInput {
  readonly id: string
  readonly claimId: string
  readonly verdict: string
  readonly notes: string | null
  readonly supersedesId: string | null
  readonly createdAt: string
}

/**
 * Tracked source evidence for change derivation. The loader supplies every
 * observation of digest-linked candidate bindings; derivation orders them
 * around the intervention instead of guessing from free-text URLs.
 */
export interface LoopSourceObservationInput {
  readonly id: string
  readonly targetId: string
  readonly collectionState: string
  readonly failure: string | null
  readonly completedAt: string
  readonly bodyDigest: string | null
}

/**
 * Explicit server-validated linkage between a recorded action and tracked
 * source bindings. Digest coincidence never nominates a binding: only rows
 * the server wrote at record time (after ownership + evidence checks) count.
 * Historical actions without rows stay unlinked (UNKNOWN), never backfilled.
 */
export interface LoopInterventionBindingInput {
  readonly interventionId: string
  readonly sourceBindingId: string
  readonly beforeSourceObservationId: string | null
}

/**
 * Tracked binding details for candidate bindings: target identity for
 * observation scoping, latest finding for the alignment dimension,
 * comparator for value equivalence. Supplied only for explicitly linked
 * bindings, never enumerated blindly.
 */
export interface LoopSourceBindingInput {
  readonly bindingId: string
  readonly targetId: string
  readonly findingState: string
  readonly comparator: string
}

/**
 * Bound representation values: one row per (binding, observation) where the
 * extractor produced output. Absent rows mean no extraction ran (304 reuse
 * or failure), never a value of their own.
 */
export interface LoopSourceValueInput {
  readonly bindingId: string
  readonly observationId: string
  readonly extractedValue: string | null
  readonly extractionState: string
}

// ---------------------------------------------------------------------------
// Derived DTO (JSON-safe, no causal wording)
// ---------------------------------------------------------------------------

export interface LoopSideDto {
  readonly observationId: string
  readonly provider: string
  readonly requestedModel: string | null
  readonly observedModel: string | null
  readonly collectedAt: string
  readonly answerText: string
  readonly citations: ReadonlyArray<{
    readonly uri: string | null
    readonly title: string | null
    readonly position: number | null
    readonly attributed: boolean
  }>
  readonly claimId: string | null
  readonly claimText: string | null
  readonly judgmentId: string | null
  readonly verdict: Verdict | null
}

export type LoopMeasurementStatus = "OK" | "MEASUREMENT_FAILED"

export interface LoopComparisonDto {
  readonly reobservationId: string
  readonly interventionId: string | null
  readonly before: LoopSideDto
  readonly after: LoopSideDto
  readonly matchClassification: MatchClassification
  readonly observedChange: ObservedChange
  readonly outcome: ObservedOutcome
  readonly causalAttribution: "UNKNOWN"
  readonly measurementStatus: LoopMeasurementStatus
  readonly displayCopy: string
  readonly comparabilityExplanation: string
}

export interface LoopAttemptDto {
  readonly intentId: string
  readonly interventionId: string | null
  readonly checkRunId: string
  readonly state: "QUEUED" | "RUNNING" | "FAILED" | "COMPLETED" | "FINALIZING"
  readonly queuedAt: string | null
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly failureClass: string | null
  readonly failureDetailSafe: string | null
  readonly observationId: string | null
  readonly reobservationId: string | null
}

export interface LoopCompletedDto {
  readonly id: string
  readonly interventionId: string | null
  readonly observationId: string
  readonly createdAt: string
  readonly after: LoopSideDto
}

export interface ExplicitUnknownDto {
  readonly subjectId: string
  readonly field: string
}

export interface IssueLoopDto {
  readonly issue: { readonly claimId: string; readonly observationId: string; readonly verdict: Verdict | null; readonly state: string }
  readonly originalObservation: LoopSideDto
  readonly originalJudgment: {
    readonly id: string
    readonly verdict: Verdict
    readonly notes: string | null
    readonly createdAt: string
  } | null
  readonly interventions: ReadonlyArray<InterventionRow>
  readonly sourceVerification: {
    readonly bindingId: string | null
    readonly alignment: SourceAlignmentState
    readonly change: SourceChangeState
    readonly beforeObservationId: string | null
    readonly afterObservationId: string | null
    readonly beforeValue: string | null
    readonly afterValue: string | null
    /** Supporting byte-level evidence only; never the change signal. */
    readonly documentChanged: boolean | null
    readonly detail: string
  }
  readonly reobservationAttempts: ReadonlyArray<LoopAttemptDto>
  readonly completedReobservations: ReadonlyArray<LoopCompletedDto>
  readonly latestComparison: LoopComparisonDto | null
  readonly explicitUnknowns: ReadonlyArray<ExplicitUnknownDto>
}

// ---------------------------------------------------------------------------
// Pure derivation (imports protocol rules, never restates them)
// ---------------------------------------------------------------------------

const VERDICTS: ReadonlyArray<string> = ["SUPPORTED", "CONTRADICTED", "PARTIAL", "INSUFFICIENT_EVIDENCE"]

/** Unknown verdict strings stay null instead of being coerced. */
export const toLoopVerdict = (v: unknown): Verdict | null =>
  typeof v === "string" && VERDICTS.includes(v) ? (v as Verdict) : null

const decodeStoredContext = Schema.decodeUnknownEither(MeasurementContextV1)

/**
 * Measurement context for one AI observation. Stored contexts decode
 * through the protocol schema; rows that predate stored contexts rebuild
 * from stored columns with the same rule the packet export uses. Any gap
 * returns null (MEASUREMENT_FAILED downstream) instead of a guess.
 */
export const toLoopMeasurementContext = (obs: LoopObservationInput): MeasurementContextV1 | null => {
  if (obs.measurementContext !== null && obs.measurementContext !== undefined) {
    const decoded = decodeStoredContext(obs.measurementContext)
    return decoded._tag === "Right" ? decoded.right : null
  }
  if (obs.questionPrompt === null || obs.questionId === null || obs.checkRunId === null) return null
  if (Number.isNaN(Date.parse(obs.collectedAt))) return null
  let surface: MeasurementContextV1["surface"]
  try {
    surface = surfaceForWorker(obs.provider, obs.requestedModel, obs.observedModel)
  } catch {
    return null
  }
  return {
    schema: schemaId.measurement,
    schema_version: PROTOCOL_VERSION,
    question: obs.questionPrompt,
    question_id: obs.questionId,
    question_version: hostedQuestionVersion(obs.questionPrompt),
    business_id: obs.businessId,
    surface,
    observed_at: new Date(obs.collectedAt).toISOString(),
    measurement_configuration: UNKNOWN,
    sample_number: 1,
    repeat_id: knownValue(obs.checkRunId),
  }
}

const toClaimRefs = (rows: ReadonlyArray<LoopClaimInput>): ClaimV1[] =>
  rows.map((r) => ({
    schema: schemaId.claim,
    schema_version: PROTOCOL_VERSION,
    id: r.id,
    business_id: "",
    observation_id: r.observationId,
    text: r.text,
    origin: "MANUAL_TRANSCRIPTION" as const,
    created_at: r.createdAt,
  }))

const toJudgmentRefs = (rows: ReadonlyArray<LoopJudgmentInput>): JudgmentV1[] =>
  rows.map((r) => ({
    schema: schemaId.judgment,
    schema_version: PROTOCOL_VERSION,
    id: r.id,
    business_id: "",
    claim_id: r.claimId,
    // latestJudgment only reads chain order; the real verdict is recovered
    // from the source row afterwards, so an unparsable verdict never
    // corrupts chain resolution here.
    verdict: toLoopVerdict(r.verdict) ?? ("SUPPORTED" as Verdict),
    notes: null,
    fact_ids: [],
    supersedes_id: r.supersedesId,
    created_at: r.createdAt,
  }))

const buildSide = (
  obs: LoopObservationInput,
  claim: LoopClaimInput | null,
  judgment: LoopJudgmentInput | null,
): LoopSideDto => ({
  observationId: obs.id,
  provider: obs.provider,
  requestedModel: obs.requestedModel,
  observedModel: obs.observedModel,
  collectedAt: obs.collectedAt,
  answerText: obs.answerText,
  citations: obs.citations.map((c) => ({ uri: c.uri, title: c.title, position: c.position, attributed: c.attributed })),
  claimId: claim?.id ?? null,
  claimText: claim?.text ?? null,
  judgmentId: judgment?.id ?? null,
  verdict: judgment ? toLoopVerdict(judgment.verdict) : null,
})

const toAlignment = (v: unknown): SourceAlignmentState =>
  v === "IN_SYNC" ? "IN_SYNC" : v === "DRIFT" ? "DRIFT" : "UNKNOWN"

interface PerBindingVerdict {
  readonly bindingId: string
  readonly alignment: SourceAlignmentState
  readonly change: SourceChangeState
  readonly beforeObservationId: string | null
  readonly afterObservationId: string | null
  readonly beforeValue: string | null
  readonly afterValue: string | null
  readonly documentChanged: boolean | null
}

/** Compare two bound representation values with existing comparator semantics. */
const compareBoundValues = (comparator: string, before: string, after: string): "IN_SYNC" | "DRIFT" | "UNKNOWN" => {
  if (comparator === "MONEY") return compareMoney(before, after)
  if (comparator === "BOOLEAN") return compareBoolean(before, after)
  if (comparator === "EXACT_TEXT") return compareExactText(before, after)
  return "UNKNOWN"
}

/**
 * Source verification from recorded actions plus tracked evidence, split
 * into two independent dimensions:
 *
 * - alignment: does the latest observed representation agree with approved
 *   truth (reuses RepresentationFinding, never duplicated here);
 * - change: did the BOUND REPRESENTATION VALUE change across the
 *   intervention boundary for the SAME tracked binding.
 *
 * Change law (V1): the before side is the relation's captured
 * before-observation (verified successful and at-or-before the action);
 * the after side is the earliest successful observation at-or-after the
 * action on the same binding. Both sides need OBSERVED, non-null extracted
 * values, compared with the existing typed comparator ("$49.00" vs "$49"
 * follows MONEY rules, not string inequality). A page whose bytes changed
 * while the bound value stayed equivalent reads UNCHANGED. Anything weaker
 * is UNKNOWN, never a guess. The binding identity comes only from explicit
 * server-validated intervention→binding relations: no URL matching, no
 * digest coincidence, no cross-binding matching.
 *
 * Value resolution mirrors effective-value semantics: an observation with
 * no value row of its own (304 reuse) resolves to the newest older
 * successful observation of the same binding carrying an OBSERVED value.
 * Body digests are supporting evidence only (documentChanged) and never
 * determine change.
 */
export const deriveSourceVerification = (args: {
  readonly interventions: ReadonlyArray<InterventionRow>
  readonly relations: ReadonlyArray<LoopInterventionBindingInput>
  readonly bindings: ReadonlyArray<LoopSourceBindingInput>
  readonly observations: ReadonlyArray<LoopSourceObservationInput>
  readonly values: ReadonlyArray<LoopSourceValueInput>
}): IssueLoopDto["sourceVerification"] => {
  const none = (
    change: SourceChangeState,
    extra?: Partial<Pick<IssueLoopDto["sourceVerification"], "bindingId" | "alignment" | "beforeObservationId" | "afterObservationId" | "beforeValue" | "afterValue" | "documentChanged">>,
  ): IssueLoopDto["sourceVerification"] => ({
    bindingId: null,
    alignment: "UNKNOWN",
    change,
    beforeObservationId: null,
    afterObservationId: null,
    beforeValue: null,
    afterValue: null,
    documentChanged: null,
    detail: SOURCE_DETAIL[change],
    ...extra,
  })
  if (args.interventions.length === 0) return none("SOURCE_NOT_CHECKED")
  // Current head: rows never referenced as another row's supersedesId.
  // Superseded rows stay history and never supply source identity.
  const supersededIds = new Set(args.interventions.flatMap((i) => (i.supersedesId ? [i.supersedesId] : [])))
  const heads = args.interventions.filter((i) => !supersededIds.has(i.id))
  const anchor = [...heads].sort((a, b) =>
    a.performedAt < b.performedAt ? -1 : a.performedAt > b.performedAt ? 1
    : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1
    : a.id < b.id ? -1 : 1,
  ).at(-1)
  if (!anchor) return none("SOURCE_UNKNOWN")
  // Only explicit server-validated relations of the anchor head nominate
  // bindings. No digest coincidence, no URL matching.
  const anchorRelations = args.relations.filter((r) => r.interventionId === anchor.id)
  const bindingsById = new Map(args.bindings.map((b) => [b.bindingId, b] as const))
  const orderedBindings = anchorRelations
    .map((r) => bindingsById.get(r.sourceBindingId) ?? null)
    .filter((b): b is LoopSourceBindingInput => b !== null)
    .sort((a, b) => (a.bindingId < b.bindingId ? -1 : 1))
  if (orderedBindings.length === 0) return none("SOURCE_UNKNOWN")
  const relationByBinding = new Map(anchorRelations.map((r) => [r.sourceBindingId, r] as const))
  const isSuccess = (o: LoopSourceObservationInput): boolean =>
    o.collectionState === "FETCHED" || o.collectionState === "NOT_MODIFIED"
  const valueByObservation = new Map(args.values.map((v) => [`${v.bindingId} ${v.observationId}`, v] as const))
  // Effective bound value for one observation: its own OBSERVED value. An
  // observation with NO value row at all (304 reuse) resolves to the newest
  // older successful observation of the same binding carrying an OBSERVED
  // value. A present-but-unusable row (FAILED/AMBIGUOUS/NOT_FOUND/...) stays
  // unknown: a failed extraction must never silently reuse an older value.
  const resolveValue = (bindingId: string, sorted: ReadonlyArray<LoopSourceObservationInput>, obsId: string): string | null => {
    const direct = valueByObservation.get(`${bindingId} ${obsId}`)
    if (direct !== undefined) {
      return direct.extractionState === "OBSERVED" && direct.extractedValue !== null ? direct.extractedValue : null
    }
    const idx = sorted.findIndex((o) => o.id === obsId)
    if (idx < 0) return null
    for (let i = idx - 1; i >= 0; i--) {
      const older = sorted[i]!
      if (!isSuccess(older)) continue
      const v = valueByObservation.get(`${bindingId} ${older.id}`)
      if (v && v.extractionState === "OBSERVED" && v.extractedValue !== null) return v.extractedValue
    }
    return null
  }
  const documentChangedOf = (
    before: LoopSourceObservationInput | null,
    after: LoopSourceObservationInput | null,
  ): boolean | null => {
    if (before?.bodyDigest == null || after?.bodyDigest == null) return null
    return before.bodyDigest.toLowerCase() !== after.bodyDigest.toLowerCase()
  }
  const verdicts: PerBindingVerdict[] = []
  for (const b of orderedBindings) {
    const mine = args.observations
      .filter((o) => o.targetId === b.targetId)
      .sort((a, c) => (a.completedAt < c.completedAt ? -1 : a.completedAt > c.completedAt ? 1 : a.id < c.id ? -1 : 1))
    const alignment = toAlignment(b.findingState)
    // Before side: the relation's captured before-observation, verified
    // successful, same binding, at-or-before the action. Anything else
    // (missing, failed, wrong target, after the action) refuses the
    // comparison instead of substituting a nearby value.
    const relation = relationByBinding.get(b.bindingId)
    const claimedBefore = relation?.beforeSourceObservationId ?? null
    const before = claimedBefore === null ? null : (mine.find((o) => o.id === claimedBefore && isSuccess(o) && o.completedAt <= anchor.performedAt) ?? null)
    const afterSuccess = mine.find((o) => isSuccess(o) && o.completedAt >= anchor.performedAt) ?? null
    if (before !== null && afterSuccess !== null) {
      const beforeValue = resolveValue(b.bindingId, mine, before.id)
      const afterValue = resolveValue(b.bindingId, mine, afterSuccess.id)
      const documentChanged = documentChangedOf(before, afterSuccess)
      const base = {
        bindingId: b.bindingId,
        alignment,
        beforeObservationId: before.id,
        afterObservationId: afterSuccess.id,
        beforeValue,
        afterValue,
        documentChanged,
      } as const
      if (beforeValue === null || afterValue === null) {
        verdicts.push({ ...base, change: "SOURCE_UNKNOWN" })
      } else {
        const compared = compareBoundValues(b.comparator, beforeValue, afterValue)
        verdicts.push({ ...base, change: compared === "UNKNOWN" ? "SOURCE_UNKNOWN" : compared === "IN_SYNC" ? "SOURCE_UNCHANGED" : "SOURCE_CHANGED" })
      }
      continue
    }
    const failedAfter = mine.find((o) => !isSuccess(o) && o.completedAt >= anchor.performedAt) ?? null
    if (failedAfter !== null) {
      verdicts.push({
        bindingId: b.bindingId, alignment, change: "SOURCE_OBSERVATION_FAILED",
        beforeObservationId: before?.id ?? null, afterObservationId: failedAfter.id,
        beforeValue: before ? resolveValue(b.bindingId, mine, before.id) : null, afterValue: null,
        documentChanged: documentChangedOf(before, failedAfter),
      })
      continue
    }
    const anyAfter = mine.find((o) => o.completedAt >= anchor.performedAt) ?? null
    if (before === null && anyAfter === null) {
      // Nothing collected around the action on this binding at all.
      verdicts.push({
        bindingId: b.bindingId, alignment, change: "SOURCE_UNKNOWN",
        beforeObservationId: null, afterObservationId: null, beforeValue: null, afterValue: null, documentChanged: null,
      })
      continue
    }
    if (anyAfter === null) {
      verdicts.push({
        bindingId: b.bindingId, alignment, change: "SOURCE_NOT_CHECKED",
        beforeObservationId: before?.id ?? null, afterObservationId: null,
        beforeValue: before ? resolveValue(b.bindingId, mine, before.id) : null, afterValue: null,
        documentChanged: null,
      })
      continue
    }
    verdicts.push({
      bindingId: b.bindingId, alignment, change: "SOURCE_UNKNOWN",
      beforeObservationId: before?.id ?? null, afterObservationId: afterSuccess?.id ?? null,
      beforeValue: before ? resolveValue(b.bindingId, mine, before.id) : null,
      afterValue: afterSuccess ? resolveValue(b.bindingId, mine, afterSuccess.id) : null,
      documentChanged: documentChangedOf(before, afterSuccess),
    })
  }
  const decisive = verdicts.filter((v) => v.change === "SOURCE_CHANGED" || v.change === "SOURCE_UNCHANGED")
  const distinct = [...new Set(decisive.map((v) => v.change))].sort()
  if (distinct.length === 1) {
    const winner = decisive.find((v) => v.change === distinct[0])!
    return {
      bindingId: winner.bindingId,
      alignment: winner.alignment,
      change: winner.change,
      beforeObservationId: winner.beforeObservationId,
      afterObservationId: winner.afterObservationId,
      beforeValue: winner.beforeValue,
      afterValue: winner.afterValue,
      documentChanged: winner.documentChanged,
      detail: SOURCE_DETAIL[winner.change],
    }
  }
  if (distinct.length > 1) {
    return {
      bindingId: null,
      alignment: "UNKNOWN",
      change: "SOURCE_UNKNOWN",
      beforeObservationId: null,
      afterObservationId: null,
      beforeValue: null,
      afterValue: null,
      documentChanged: null,
      detail: "Tracked bindings disagree across the recorded action, so the source change stays unknown.",
    }
  }
  const failed = verdicts.find((v) => v.change === "SOURCE_OBSERVATION_FAILED") ?? null
  if (failed) {
    return {
      bindingId: failed.bindingId,
      alignment: failed.alignment,
      change: failed.change,
      beforeObservationId: failed.beforeObservationId,
      afterObservationId: failed.afterObservationId,
      beforeValue: failed.beforeValue,
      afterValue: failed.afterValue,
      documentChanged: failed.documentChanged,
      detail: SOURCE_DETAIL[failed.change],
    }
  }
  const notChecked = verdicts.find((v) => v.change === "SOURCE_NOT_CHECKED") ?? null
  if (notChecked) {
    return {
      bindingId: notChecked.bindingId,
      alignment: notChecked.alignment,
      change: notChecked.change,
      beforeObservationId: notChecked.beforeObservationId,
      afterObservationId: notChecked.afterObservationId,
      beforeValue: notChecked.beforeValue,
      afterValue: notChecked.afterValue,
      documentChanged: notChecked.documentChanged,
      detail: SOURCE_DETAIL[notChecked.change],
    }
  }
  return none("SOURCE_UNKNOWN")
}

const comparisonCopy = (c: {
  readonly measurementStatus: LoopMeasurementStatus
  readonly matchClassification: MatchClassification
  readonly afterVerdict: Verdict | null
  readonly outcome: ObservedOutcome
}): { displayCopy: string; comparabilityExplanation: string } => {
  if (c.measurementStatus === "MEASUREMENT_FAILED" || c.matchClassification === "NOT_COMPARABLE") {
    return {
      displayCopy: LOOP_DISPLAY_COPY.incomparable,
      comparabilityExplanation:
        c.measurementStatus === "MEASUREMENT_FAILED"
          ? "The stored measurement details are incomplete, so the two answers cannot be compared."
          : "The recheck ran under different measurement conditions, so the two answers cannot be compared.",
    }
  }
  if (c.matchClassification === "INDETERMINATE") {
    return {
      displayCopy: LOOP_DISPLAY_COPY.incomparable,
      comparabilityExplanation: "Some measurement details are unknown, so comparability cannot be established.",
    }
  }
  if (c.afterVerdict === null) {
    return {
      displayCopy: LOOP_DISPLAY_COPY.needsReview,
      comparabilityExplanation: "The rechecked answer has not been reviewed yet.",
    }
  }
  if (c.outcome === "NO_OBSERVED_CHANGE") {
    return {
      displayCopy: LOOP_DISPLAY_COPY.noChange,
      comparabilityExplanation: "Both answers were collected under comparable conditions and read the same.",
    }
  }
  return {
    displayCopy: LOOP_DISPLAY_COPY.changed,
    comparabilityExplanation: "Both answers were collected under comparable conditions and read differently.",
  }
}

/**
 * Before/after comparison for one completed re-observation. Match, change,
 * and outcome come only from the protocol measurement functions; an
 * unreviewed (or ambiguous) after-claim leaves after_verdict null, which
 * forces INDETERMINATE. Attribution is always UNKNOWN: V1 has no
 * experiment protocol that could establish more.
 */
export const buildLoopComparison = (args: {
  readonly reobservationId: string
  readonly interventionId: string | null
  readonly beforeObservation: LoopObservationInput
  readonly afterObservation: LoopObservationInput
  readonly beforeClaim: LoopClaimInput
  readonly beforeJudgment: LoopJudgmentInput | null
  readonly afterClaim: LoopClaimInput | null
  readonly afterJudgment: LoopJudgmentInput | null
}): LoopComparisonDto => {
  const beforeCtx = toLoopMeasurementContext(args.beforeObservation)
  const afterCtx = toLoopMeasurementContext(args.afterObservation)
  const beforeVerdict = args.beforeJudgment ? toLoopVerdict(args.beforeJudgment.verdict) : null
  // Null when the after-claim is missing, unreviewed, or ambiguous: the
  // outcome below stays INDETERMINATE either way.
  const afterVerdict = args.afterJudgment ? toLoopVerdict(args.afterJudgment.verdict) : null
  let matchClassification: MatchClassification = "INDETERMINATE"
  let observedChange: ObservedChange = "INDETERMINATE"
  let outcome: ObservedOutcome = "INDETERMINATE"
  let measurementStatus: LoopMeasurementStatus = "MEASUREMENT_FAILED"
  if (beforeCtx !== null && afterCtx !== null) {
    measurementStatus = "OK"
    matchClassification = compareMeasurements(measurementSignature(beforeCtx), measurementSignature(afterCtx))
    observedChange = deriveObservedChange(matchClassification, args.beforeObservation.answerText, args.afterObservation.answerText)
    outcome = deriveOutcome(beforeVerdict, afterVerdict, matchClassification, observedChange)
  }
  const copy = comparisonCopy({ measurementStatus, matchClassification, afterVerdict, outcome })
  return {
    reobservationId: args.reobservationId,
    interventionId: args.interventionId,
    before: buildSide(args.beforeObservation, args.beforeClaim, args.beforeJudgment),
    after: buildSide(args.afterObservation, args.afterClaim, args.afterJudgment),
    matchClassification,
    observedChange,
    outcome,
    causalAttribution: "UNKNOWN",
    measurementStatus,
    displayCopy: copy.displayCopy,
    comparabilityExplanation: copy.comparabilityExplanation,
  }
}

/**
 * Derived issue loop: the issue, its original observation and judgment,
 * recorded actions, digest-linked source verification, every re-observation
 * attempt, the completed ones, the latest before/after comparison, and the
 * explicit unknowns. Unreviewed rows stay null all the way through.
 */
export const buildIssueLoop = (args: {
  readonly claim: LoopClaimInput
  readonly originalObservation: LoopObservationInput
  readonly claims: ReadonlyArray<LoopClaimInput>
  readonly judgments: ReadonlyArray<LoopJudgmentInput>
  readonly interventions: ReadonlyArray<InterventionRow>
  readonly reobservations: ReadonlyArray<ReobservationRow>
  readonly afterObservations: ReadonlyMap<string, LoopObservationInput>
  readonly relations: ReadonlyArray<LoopInterventionBindingInput>
  readonly sourceBindings: ReadonlyArray<LoopSourceBindingInput>
  readonly sourceObservations: ReadonlyArray<LoopSourceObservationInput>
  readonly sourceValues: ReadonlyArray<LoopSourceValueInput>
  readonly intents: ReadonlyArray<ReobservationIntentRow>
  readonly checkRuns: ReadonlyMap<string, CheckRunRow>
  /** Observation id per check run id, for runs that produced one. */
  readonly runObservations: ReadonlyMap<string, string>
}): IssueLoopDto => {
  const judgmentRefs = toJudgmentRefs(args.judgments)
  const claimRefs = toClaimRefs(args.claims)
  const beforeHead = latestJudgment(judgmentRefs, args.claim.id)
  const beforeJudgment = beforeHead ? (args.judgments.find((j) => j.id === beforeHead.id) ?? null) : null
  const beforeVerdict = beforeJudgment ? toLoopVerdict(beforeJudgment.verdict) : null

  const ordered = [...args.reobservations].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  )
  const unknowns: ExplicitUnknownDto[] = []
  // Attempts derive from durable intents joined to their check runs, never
  // from finalized links alone: QUEUED/RUNNING/FAILED attempts stay visible
  // with their evidence. SUCCEEDED with a link is COMPLETED; SUCCEEDED with
  // an observation but no link yet is FINALIZING (the sweeper finalizes it;
  // a genuinely crashed window, not an outcome).
  const linkByObservationId = new Map(args.reobservations.map((r) => [r.observationId, r] as const))
  const orderedIntents = [...args.intents].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  )
  const attempts: LoopAttemptDto[] = []
  for (const intent of orderedIntents) {
    const run = args.checkRuns.get(intent.checkRunId)
    if (!run) {
      unknowns.push({ subjectId: intent.id, field: "recheck_attempt" })
      continue
    }
    const observationId = args.runObservations.get(intent.checkRunId) ?? null
    const link = observationId === null ? undefined : linkByObservationId.get(observationId)
    if (run.status === "QUEUED" || run.status === "RUNNING") {
      attempts.push({
        intentId: intent.id,
        interventionId: intent.interventionId,
        checkRunId: run.id,
        state: run.status,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        failureClass: null,
        failureDetailSafe: null,
        observationId: null,
        reobservationId: null,
      })
    } else if (run.status === "FAILED") {
      attempts.push({
        intentId: intent.id,
        interventionId: intent.interventionId,
        checkRunId: run.id,
        state: "FAILED",
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        failureClass: run.failureClass,
        failureDetailSafe: run.failureDetailSafe,
        observationId,
        reobservationId: null,
      })
    } else if (link) {
      attempts.push({
        intentId: intent.id,
        interventionId: intent.interventionId,
        checkRunId: run.id,
        state: "COMPLETED",
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        failureClass: null,
        failureDetailSafe: null,
        observationId,
        reobservationId: link.id,
      })
    } else {
      attempts.push({
        intentId: intent.id,
        interventionId: intent.interventionId,
        checkRunId: run.id,
        state: "FINALIZING",
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        failureClass: null,
        failureDetailSafe: null,
        observationId,
        reobservationId: null,
      })
    }
  }

  const completed: LoopCompletedDto[] = []
  if (beforeJudgment === null) unknowns.push({ subjectId: args.claim.id, field: "verdict" })
  if (toLoopMeasurementContext(args.originalObservation) === null) {
    unknowns.push({ subjectId: args.originalObservation.id, field: "measurement_context" })
  }

  let latestComparison: LoopComparisonDto | null = null
  for (const r of ordered) {
    const afterObs = args.afterObservations.get(r.observationId)
    if (!afterObs) {
      unknowns.push({ subjectId: r.id, field: "after_observation" })
      continue
    }
    const afterClaimRef = soleClaim(claimRefs, afterObs.id)
    const afterClaim = afterClaimRef ? (args.claims.find((c) => c.id === afterClaimRef.id) ?? null) : null
    const afterHead = afterClaimRef ? latestJudgment(judgmentRefs, afterClaimRef.id) : null
    const afterJudgment = afterHead ? (args.judgments.find((j) => j.id === afterHead.id) ?? null) : null
    completed.push({
      id: r.id,
      interventionId: r.interventionId,
      observationId: r.observationId,
      createdAt: r.createdAt,
      after: buildSide(afterObs, afterClaim, afterJudgment),
    })
    if (afterClaimRef === null) unknowns.push({ subjectId: r.id, field: "after_claim" })
    else if (afterJudgment === null) unknowns.push({ subjectId: r.id, field: "after_verdict" })
    if (toLoopMeasurementContext(afterObs) === null) {
      unknowns.push({ subjectId: afterObs.id, field: "measurement_context" })
    }
    latestComparison = buildLoopComparison({
      reobservationId: r.id,
      interventionId: r.interventionId,
      beforeObservation: args.originalObservation,
      afterObservation: afterObs,
      beforeClaim: args.claim,
      beforeJudgment,
      afterClaim,
      afterJudgment,
    })
  }

  if (args.interventions.length > 0 && completed.length === 0) {
    unknowns.push({ subjectId: args.claim.id, field: "outcome_after_intervention" })
  }
  if (args.interventions.length > 0 || args.reobservations.length > 0) {
    unknowns.push({ subjectId: args.claim.id, field: "causal_attribution" })
  }

  const originalVerdict = beforeJudgment ? toLoopVerdict(beforeJudgment.verdict) : null
  return {
    issue: {
      claimId: args.claim.id,
      observationId: args.claim.observationId,
      verdict: beforeVerdict,
      state: issueStateOf(beforeVerdict),
    },
    originalObservation: buildSide(args.originalObservation, args.claim, beforeJudgment),
    originalJudgment:
      beforeJudgment && originalVerdict
        ? { id: beforeJudgment.id, verdict: originalVerdict, notes: beforeJudgment.notes, createdAt: beforeJudgment.createdAt }
        : null,
    interventions: args.interventions,
    sourceVerification: deriveSourceVerification({
      interventions: args.interventions,
      relations: args.relations,
      bindings: args.sourceBindings,
      observations: args.sourceObservations,
      values: args.sourceValues,
    }),
    reobservationAttempts: attempts,
    completedReobservations: completed,
    latestComparison,
    explicitUnknowns: unknowns,
  }
}

// ---------------------------------------------------------------------------
// Loader (authenticated, tenant-scoped, read-only)
// ---------------------------------------------------------------------------

const rowId = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)
const rowText = (v: unknown): string | null => (typeof v === "string" ? v : null)
const rowIso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const toObservationInput = (
  row: Record<string, unknown>,
  citations: ReadonlyArray<Record<string, unknown>>,
): LoopObservationInput | null => {
  const oid = rowId(row["id"])
  const businessId = rowId(row["business_id"])
  const provider = rowText(row["provider"])
  const collectedAt = rowIso(row["collected_at"])
  const answerText = rowText(row["answer_text"])
  if (oid === null || businessId === null || provider === null || collectedAt === null || answerText === null) return null
  const requestedModel = rowText(row["requested_model"])
  const observedModel = rowText(row["observed_model"])
  return {
    id: oid,
    businessId,
    checkRunId: rowId(row["check_run_id"]),
    questionId: rowId(row["question_id"]),
    questionPrompt: rowText(row["question_prompt"]),
    provider,
    requestedModel,
    observedModel,
    collectedAt,
    answerText,
    citations: citations
      .filter((c) => String(c["observation_id"]) === oid)
      .map((c) => ({
        uri: (c["uri"] as string | null) ?? null,
        title: (c["title"] as string | null) ?? null,
        position: typeof c["position"] === "number" ? (c["position"] as number) : null,
        attributed: Boolean(c["attributed"]),
      })),
    measurementContext: (row["measurement_context"] as unknown) ?? null,
  }
}

/** Authenticated issue loop for one claim, or null when it is unknown here. */
export const loadIssueLoop = (accountId: string, businessId: string, claimId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const lineageRepo = yield* EvidenceLineageRepository
    const lineage = yield* lineageRepo.loadIssue(accountId, businessId, claimId)
    if (!lineage) return null

    const claimRow = lineage.claim as Record<string, unknown>
    const issueClaimId = rowId(claimRow["id"])
    const issueObservationId = rowId(claimRow["observation_id"])
    const issueText = rowText(claimRow["text"])
    const issueCreatedAt = rowIso(claimRow["created_at"])
    if (issueClaimId === null || issueObservationId === null || issueText === null || issueCreatedAt === null) return null

    const observationRows = lineage.observations as ReadonlyArray<Record<string, unknown>>
    const citationRows = lineage.citations as ReadonlyArray<Record<string, unknown>>
    const originalRow = observationRows.find((o) => String(o["id"]) === issueObservationId)
    if (!originalRow) return null
    const originalObservation = toObservationInput(originalRow as Record<string, unknown>, citationRows)
    if (!originalObservation) return null

    const afterObservations = new Map<string, LoopObservationInput>()
    for (const o of observationRows) {
      const input = toObservationInput(o as Record<string, unknown>, citationRows)
      if (input && input.id !== issueObservationId) afterObservations.set(input.id, input)
    }

    const claims: LoopClaimInput[] = []
    for (const c of lineage.claims as ReadonlyArray<Record<string, unknown>>) {
      const cid = rowId(c["id"])
      const cobs = rowId(c["observation_id"])
      const ctext = rowText(c["text"])
      const ccreated = rowIso(c["created_at"])
      if (cid === null || cobs === null || ctext === null || ccreated === null) continue
      claims.push({ id: cid, observationId: cobs, text: ctext, createdAt: ccreated })
    }
    if (!claims.some((c) => c.id === issueClaimId)) {
      claims.push({ id: issueClaimId, observationId: issueObservationId, text: issueText, createdAt: issueCreatedAt })
    }

    const judgments: LoopJudgmentInput[] = []
    for (const j of lineage.judgments as ReadonlyArray<Record<string, unknown>>) {
      const jid = rowId(j["id"])
      const jclaim = rowId(j["claim_id"])
      const jverdict = rowText(j["verdict"])
      const jcreated = rowIso(j["created_at"])
      if (jid === null || jclaim === null || jverdict === null || jcreated === null) continue
      judgments.push({
        id: jid,
        claimId: jclaim,
        verdict: jverdict,
        notes: rowText(j["notes"]),
        supersedesId: rowId(j["supersedes_id"]),
        createdAt: jcreated,
      })
    }

    // Source linkage is explicit only: server-validated intervention→binding
    // relations written at record time. Digest coincidence, free-text URLs,
    // and hostnames never nominate a binding, so actions without a relation
    // stay UNKNOWN instead of matching an arbitrary source.
    const relationsRepo = yield* InterventionBindingRepository
    const relations = yield* relationsRepo.listByIssue(businessId, claimId)
    const sourceBindings: LoopSourceBindingInput[] = []
    const sourceObservations: LoopSourceObservationInput[] = []
    const sourceValues: LoopSourceValueInput[] = []
    if (relations.length > 0) {
      const reads = yield* ProductReadRepository
      const representations = (yield* loadRepresentations(accountId, businessId)) ?? []
      const findingByBinding = new Map(representations.map((r) => [r.binding_id, r.finding.state] as const))
      const allBindings = yield* reads.bindings(businessId)
      const bindingById = new Map(allBindings.map((b) => [b.id, b] as const))
      const wantedTargets = new Set<string>()
      for (const rel of relations) {
        const b = bindingById.get(rel.sourceBindingId)
        if (b === undefined) continue
        wantedTargets.add(b.sourceTargetId)
        sourceBindings.push({
          bindingId: b.id,
          targetId: b.sourceTargetId,
          findingState: findingByBinding.get(b.id) ?? "UNKNOWN",
          comparator: b.comparator,
        })
      }
      const sourceObs = yield* reads.observations(businessId)
      for (const so of sourceObs) {
        if (!wantedTargets.has(so.sourceTargetId)) continue
        const completedAt = so.completedAt
        if (completedAt === null) continue
        sourceObservations.push({
          id: so.id,
          targetId: so.sourceTargetId,
          collectionState: so.collectionState,
          failure: so.failure,
          completedAt,
          bodyDigest: so.bodyDigest,
        })
      }
      const sourceVals = yield* reads.values(businessId)
      const wantedBindings = new Set(sourceBindings.map((b) => b.bindingId))
      for (const v of sourceVals) {
        if (!wantedBindings.has(v.sourceBindingId)) continue
        sourceValues.push({
          bindingId: v.sourceBindingId,
          observationId: v.sourceObservationId,
          extractedValue: v.extractedValue,
          extractionState: v.extractionState,
        })
      }
    }

    const intentsRepo = yield* ReobservationIntentRepository
    const intentRows = yield* intentsRepo.listByIssue(businessId, claimId)
    const runsRepo = yield* CheckRunRepository
    const obsRepo = yield* ObservationRepository
    const checkRuns = new Map<string, CheckRunRow>()
    const runObservations = new Map<string, string>()
    for (const intent of intentRows) {
      const run = yield* runsRepo.getScoped(businessId, intent.checkRunId)
      if (!run) continue
      checkRuns.set(run.id, run)
      const obs = yield* obsRepo.getByCheckRun(run.id)
      if (obs && obs.businessId === businessId) runObservations.set(run.id, obs.id)
    }

    return buildIssueLoop({
      claim: { id: issueClaimId, observationId: issueObservationId, text: issueText, createdAt: issueCreatedAt },
      originalObservation,
      claims,
      judgments,
      interventions: lineage.interventions,
      reobservations: lineage.reobservations,
      afterObservations,
      relations: relations.map((r) => ({
        interventionId: r.interventionId,
        sourceBindingId: r.sourceBindingId,
        beforeSourceObservationId: r.beforeSourceObservationId,
      })),
      sourceBindings,
      sourceObservations,
      sourceValues,
      intents: intentRows,
      checkRuns,
      runObservations,
    })
  })
