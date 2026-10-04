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
import {
  EvidenceLineageRepository,
  ProductReadRepository,
  hostedQuestionVersion,
  type InterventionRow,
  type ReobservationRow,
} from "@ghostping/db"
import { issueStateOf, loadRepresentations, scopedBusiness } from "./reads.js"

// ---------------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------------

/** Source verification states for one issue. Derived, never asserted. */
export type SourceVerificationState =
  | "SOURCE_NOT_CHECKED"
  | "SOURCE_OBSERVED_UNCHANGED"
  | "SOURCE_OBSERVED_CHANGED"
  | "SOURCE_OBSERVATION_FAILED"
  | "SOURCE_UNKNOWN"

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

const SOURCE_DETAIL: Record<SourceVerificationState, string> = {
  SOURCE_NOT_CHECKED: "No action has been recorded for this issue, so there is no source follow-up to report.",
  SOURCE_UNKNOWN: "The source state cannot be established from tracked evidence, so it stays unknown.",
  SOURCE_OBSERVED_UNCHANGED: "Tracked source evidence linked to the action still shows the approved value.",
  SOURCE_OBSERVED_CHANGED: "Tracked source evidence linked to the action shows a value different from the approved value.",
  SOURCE_OBSERVATION_FAILED: "The linked source observation failed to collect, so the source state is unknown.",
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
 * Explicit structured linkage between a recorded action and tracked source
 * evidence. The loader establishes links by content digest only; free-text
 * action targets are never string-matched to source URLs, so an unlinked
 * action keeps SOURCE_UNKNOWN instead of a guessed binding.
 */
export interface LoopSourceLinkInput {
  readonly observationId: string
  readonly bindingId: string | null
  readonly findingState: string
  readonly collectionState: string
  readonly failure: string | null
  readonly completedAt: string
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
  readonly id: string
  readonly interventionId: string | null
  readonly observationId: string
  readonly createdAt: string
  readonly status: "COMPLETED" | "PENDING"
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
    readonly state: SourceVerificationState
    readonly detail: string
    readonly linkedBindingId: string | null
    readonly linkedObservationId: string | null
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

/**
 * Source verification from recorded actions plus explicit digest links.
 * No link is ever inferred from free-text URLs, and the answer is a state
 * string, never a manual boolean.
 */
export const deriveSourceVerification = (args: {
  readonly interventions: ReadonlyArray<InterventionRow>
  readonly links: ReadonlyArray<LoopSourceLinkInput>
}): IssueLoopDto["sourceVerification"] => {
  if (args.interventions.length === 0) {
    return { state: "SOURCE_NOT_CHECKED", detail: SOURCE_DETAIL.SOURCE_NOT_CHECKED, linkedBindingId: null, linkedObservationId: null }
  }
  if (args.links.length === 0) {
    return { state: "SOURCE_UNKNOWN", detail: SOURCE_DETAIL.SOURCE_UNKNOWN, linkedBindingId: null, linkedObservationId: null }
  }
  const ordered = [...args.links].sort((a, b) =>
    a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1
    : a.observationId < b.observationId ? -1 : a.observationId > b.observationId ? 1
    : (a.bindingId ?? "") < (b.bindingId ?? "") ? -1 : 1,
  )
  const latest = ordered.at(-1)
  if (!latest) {
    return { state: "SOURCE_UNKNOWN", detail: SOURCE_DETAIL.SOURCE_UNKNOWN, linkedBindingId: null, linkedObservationId: null }
  }
  if (latest.failure !== null || latest.collectionState === "FAILED") {
    return {
      state: "SOURCE_OBSERVATION_FAILED",
      detail: SOURCE_DETAIL.SOURCE_OBSERVATION_FAILED,
      linkedBindingId: latest.bindingId,
      linkedObservationId: latest.observationId,
    }
  }
  if (latest.findingState === "IN_SYNC") {
    return {
      state: "SOURCE_OBSERVED_UNCHANGED",
      detail: SOURCE_DETAIL.SOURCE_OBSERVED_UNCHANGED,
      linkedBindingId: latest.bindingId,
      linkedObservationId: latest.observationId,
    }
  }
  if (latest.findingState === "DRIFT") {
    return {
      state: "SOURCE_OBSERVED_CHANGED",
      detail: SOURCE_DETAIL.SOURCE_OBSERVED_CHANGED,
      linkedBindingId: latest.bindingId,
      linkedObservationId: latest.observationId,
    }
  }
  return {
    state: "SOURCE_UNKNOWN",
    detail: SOURCE_DETAIL.SOURCE_UNKNOWN,
    linkedBindingId: latest.bindingId,
    linkedObservationId: latest.observationId,
  }
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
  readonly sourceLinks: ReadonlyArray<LoopSourceLinkInput>
}): IssueLoopDto => {
  const judgmentRefs = toJudgmentRefs(args.judgments)
  const claimRefs = toClaimRefs(args.claims)
  const beforeHead = latestJudgment(judgmentRefs, args.claim.id)
  const beforeJudgment = beforeHead ? (args.judgments.find((j) => j.id === beforeHead.id) ?? null) : null
  const beforeVerdict = beforeJudgment ? toLoopVerdict(beforeJudgment.verdict) : null

  const ordered = [...args.reobservations].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  )
  const attempts: LoopAttemptDto[] = ordered.map((r) => ({
    id: r.id,
    interventionId: r.interventionId,
    observationId: r.observationId,
    createdAt: r.createdAt,
    status: args.afterObservations.has(r.observationId) ? "COMPLETED" : "PENDING",
  }))

  const completed: LoopCompletedDto[] = []
  const unknowns: ExplicitUnknownDto[] = []
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
    sourceVerification: deriveSourceVerification({ interventions: args.interventions, links: args.sourceLinks }),
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

    // Source linkage by content digest only. A recorded action carries
    // optional evidence digests; a tracked source observation carries a body
    // digest. Equal digests link them. Free-text targets are never
    // string-matched to source URLs, so unlinked actions stay UNKNOWN.
    const wanted = new Set<string>()
    for (const iv of lineage.interventions) {
      if (iv.evidenceBeforeDigest !== null) wanted.add(iv.evidenceBeforeDigest.toLowerCase())
      if (iv.evidenceAfterDigest !== null) wanted.add(iv.evidenceAfterDigest.toLowerCase())
    }
    const sourceLinks: LoopSourceLinkInput[] = []
    if (wanted.size > 0) {
      const reads = yield* ProductReadRepository
      const representations = (yield* loadRepresentations(accountId, businessId)) ?? []
      const sourceObs = yield* reads.observations(businessId)
      for (const so of sourceObs) {
        if (so.bodyDigest === null || !wanted.has(so.bodyDigest.toLowerCase())) continue
        const linked = representations.filter(
          (r) =>
            r.effective_observation?.observation_id === so.id || r.latest_successful_check?.observation_id === so.id,
        )
        if (linked.length === 0) {
          sourceLinks.push({
            observationId: so.id,
            bindingId: null,
            findingState: "UNKNOWN",
            collectionState: so.collectionState,
            failure: so.failure,
            completedAt: so.completedAt,
          })
        }
        for (const rep of linked) {
          sourceLinks.push({
            observationId: so.id,
            bindingId: rep.binding_id,
            findingState: rep.finding.state,
            collectionState: so.collectionState,
            failure: so.failure,
            completedAt: so.completedAt,
          })
        }
      }
    }

    return buildIssueLoop({
      claim: { id: issueClaimId, observationId: issueObservationId, text: issueText, createdAt: issueCreatedAt },
      originalObservation,
      claims,
      judgments,
      interventions: lineage.interventions,
      reobservations: lineage.reobservations,
      afterObservations,
      sourceLinks,
    })
  })
