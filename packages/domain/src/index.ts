// Canonical hosted domain model for OpenRecord Hosted V1.
// All contracts derive from Effect Schema. No duplicated Zod/OpenAPI/decoders.
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Branded ids
// ---------------------------------------------------------------------------
export const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
export type AccountId = typeof AccountId.Type
export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
export const BusinessId = Schema.String.pipe(Schema.brand("BusinessId"))
export type BusinessId = typeof BusinessId.Type
export const FactId = Schema.String.pipe(Schema.brand("FactId"))
export type FactId = typeof FactId.Type
export const QuestionId = Schema.String.pipe(Schema.brand("QuestionId"))
export type QuestionId = typeof QuestionId.Type
export const CheckRunId = Schema.String.pipe(Schema.brand("CheckRunId"))
export type CheckRunId = typeof CheckRunId.Type
export const ObservationId = Schema.String.pipe(Schema.brand("ObservationId"))
export type ObservationId = typeof ObservationId.Type
export const ClaimId = Schema.String.pipe(Schema.brand("ClaimId"))
export type ClaimId = typeof ClaimId.Type
export const JudgmentId = Schema.String.pipe(Schema.brand("JudgmentId"))
export type JudgmentId = typeof JudgmentId.Type

// ---------------------------------------------------------------------------
// Account / User / Business
// ---------------------------------------------------------------------------
export const Account = Schema.Struct({
  id: AccountId,
  name: Schema.String,
  createdAt: Schema.DateTimeUtc,
})
export type Account = typeof Account.Type

export const User = Schema.Struct({
  id: UserId,
  accountId: AccountId,
  email: Schema.String,
  createdAt: Schema.DateTimeUtc,
})
export type User = typeof User.Type

export const Business = Schema.Struct({
  id: BusinessId,
  accountId: AccountId,
  name: Schema.String,
  createdAt: Schema.DateTimeUtc,
})
export type Business = typeof Business.Type

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------
export const FactValueType = Schema.Literal(
  "TEXT",
  "NUMBER",
  "CURRENCY",
  "BOOLEAN",
  "DATE",
  "URL",
  "ENUM",
)
export type FactValueType = typeof FactValueType.Type

export const FactStatus = Schema.Literal("ACTIVE", "SUPERSEDED", "RETIRED")
export type FactStatus = typeof FactStatus.Type

export const FactSourceKind = Schema.Literal(
  "MANUAL",
  "WEBSITE",
  "PRODUCT_CATALOG",
  "POLICY_DOCUMENT",
  "OTHER",
)
export type FactSourceKind = typeof FactSourceKind.Type

export const AuthoritativeFact = Schema.Struct({
  id: FactId,
  businessId: BusinessId,
  subject: Schema.String,
  predicate: Schema.String,
  valueText: Schema.String,
  valueType: FactValueType,
  status: FactStatus,
  version: Schema.Number,
  supersedesId: Schema.optional(Schema.NullOr(FactId)),
  // Validity uses [start, end) as absolute UTC instants.
  validFrom: Schema.DateTimeUtc,
  validUntil: Schema.NullOr(Schema.DateTimeUtc),
  sourceKind: FactSourceKind,
  createdAt: Schema.DateTimeUtc,
})
export type AuthoritativeFact = typeof AuthoritativeFact.Type

// ---------------------------------------------------------------------------
// Buyer questions
// ---------------------------------------------------------------------------
export const QuestionOrigin = Schema.Literal(
  "BUSINESS_OWNER",
  "SALES",
  "SUPPORT",
  "CUSTOMER_INTERVIEW",
  "SEARCH_DATA",
  "OPERATOR_CONSTRUCTED",
  "OTHER",
)
export type QuestionOrigin = typeof QuestionOrigin.Type

export const BuyerQuestion = Schema.Struct({
  id: QuestionId,
  businessId: BusinessId,
  label: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  origin: QuestionOrigin,
  active: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
})
export type BuyerQuestion = typeof BuyerQuestion.Type

// ---------------------------------------------------------------------------
// Check runs
// ---------------------------------------------------------------------------
export const CheckRunStatus = Schema.Literal("QUEUED", "RUNNING", "SUCCEEDED", "FAILED")
export type CheckRunStatus = typeof CheckRunStatus.Type

export const FailureClass = Schema.Literal(
  "NONE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_AUTH",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_MALFORMED",
  "PROVIDER_UNSUPPORTED",
  "PROVIDER_CONTRACT_MISMATCH",
  "WORKER_FAILED",
  // The worker's lease on a RUNNING check expired (crash, kill, partition).
  "WORKER_LOST",
  "WORKER_CONTRACT_MISMATCH",
  "UNKNOWN",
)
export type FailureClass = typeof FailureClass.Type

export const CheckRun = Schema.Struct({
  id: CheckRunId,
  businessId: BusinessId,
  questionId: QuestionId,
  provider: Schema.String,
  requestedModel: Schema.NullOr(Schema.String),
  status: CheckRunStatus,
  queuedAt: Schema.DateTimeUtc,
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  failureClass: Schema.NullOr(FailureClass),
  failureDetailSafe: Schema.NullOr(Schema.String),
})
export type CheckRun = typeof CheckRun.Type

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------
export const RetrievalMode = Schema.Literal("unknown", "grounded", "parametric")
export type RetrievalMode = typeof RetrievalMode.Type

export const ObservationCitation = Schema.Struct({
  uri: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  position: Schema.NullOr(Schema.Number),
  attributed: Schema.Boolean,
})
export type ObservationCitation = typeof ObservationCitation.Type

export const Observation = Schema.Struct({
  id: ObservationId,
  businessId: BusinessId,
  checkRunId: CheckRunId,
  provider: Schema.String,
  requestedModel: Schema.NullOr(Schema.String),
  observedModel: Schema.NullOr(Schema.String),
  collectedAt: Schema.DateTimeUtc,
  answerText: Schema.String,
  retrievalMode: RetrievalMode,
  rawEvidenceId: Schema.String,
  rawDigest: Schema.String,
  citations: Schema.Array(ObservationCitation),
})
export type Observation = typeof Observation.Type

export const CandidateClaimOrigin = Schema.Literal(
  "MANUAL_TRANSCRIPTION",
  "MANUAL_EXACT_SPAN",
)
export type CandidateClaimOrigin = typeof CandidateClaimOrigin.Type

export const CandidateClaim = Schema.Struct({
  id: ClaimId,
  businessId: BusinessId,
  observationId: ObservationId,
  text: Schema.String,
  origin: CandidateClaimOrigin,
  createdAt: Schema.DateTimeUtc,
})
export type CandidateClaim = typeof CandidateClaim.Type

// ---------------------------------------------------------------------------
// Judgments
// ---------------------------------------------------------------------------
export const JudgmentVerdict = Schema.Literal(
  "SUPPORTED",
  "CONTRADICTED",
  "PARTIAL",
  "INSUFFICIENT_EVIDENCE",
)
export type JudgmentVerdict = typeof JudgmentVerdict.Type

export const HumanJudgment = Schema.Struct({
  id: JudgmentId,
  businessId: BusinessId,
  claimId: ClaimId,
  verdict: JudgmentVerdict,
  notes: Schema.NullOr(Schema.String),
  factIds: Schema.Array(FactId),
  supersedesId: Schema.NullOr(JudgmentId),
  createdAt: Schema.DateTimeUtc,
})
export type HumanJudgment = typeof HumanJudgment.Type

// ---------------------------------------------------------------------------
// Issues (derived)
// ---------------------------------------------------------------------------
export const IssueState = Schema.Literal(
  "WRONG",
  "PARTIAL",
  "NEEDS_REVIEW",
  "UNKNOWN",
  "RESOLVED",
)
export type IssueState = typeof IssueState.Type

export const DerivedIssue = Schema.Struct({
  claimId: ClaimId,
  businessId: BusinessId,
  observationId: ObservationId,
  state: IssueState,
  verdict: Schema.NullOr(JudgmentVerdict),
  judgmentId: Schema.NullOr(JudgmentId),
})
export type DerivedIssue = typeof DerivedIssue.Type

export const deriveIssueState = (
  latest: HumanJudgment | null | undefined,
): Exclude<IssueState, "RESOLVED"> | "RESOLVED" => {
  if (!latest) return "NEEDS_REVIEW"
  switch (latest.verdict) {
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

export const deriveIssue = (input: {
  claimId: ClaimId
  businessId: BusinessId
  observationId: ObservationId
  latest: HumanJudgment | null | undefined
}): DerivedIssue => ({
  claimId: input.claimId,
  businessId: input.businessId,
  observationId: input.observationId,
  state: deriveIssueState(input.latest),
  verdict: input.latest?.verdict ?? null,
  judgmentId: input.latest?.id ?? null,
})

export const isAttentionIssue = (state: IssueState): boolean =>
  state === "WRONG" || state === "PARTIAL" || state === "NEEDS_REVIEW" || state === "UNKNOWN"

// ---------------------------------------------------------------------------
// Temporal semantics: [start, end), UTC normalization.
// UTC is a V1 normalization convention, not the business's local timezone.
// ---------------------------------------------------------------------------
export const dateOnlyToStartUtc = (dateOnly: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly)
  if (!m) throw new Error(`InvalidFactValue: expected YYYY-MM-DD, got ${dateOnly}`)
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0))
}

export const dateOnlyToEndExclusiveUtc = (dateOnly: string): Date => {
  const start = dateOnlyToStartUtc(dateOnly)
  return new Date(start.getTime() + 24 * 60 * 60 * 1000)
}

export const toInstant = (rfc3339: string): Date => {
  const d = new Date(rfc3339)
  if (Number.isNaN(d.getTime())) throw new Error(`InvalidFactValue: bad timestamp ${rfc3339}`)
  return d
}

export interface ValidityInterval {
  readonly start: Date
  readonly end: Date | null
}

export const intervalsOverlap = (a: ValidityInterval, b: ValidityInterval): boolean => {
  const aEnd = a.end?.getTime() ?? Number.POSITIVE_INFINITY
  const bEnd = b.end?.getTime() ?? Number.POSITIVE_INFINITY
  return a.start.getTime() < bEnd && b.start.getTime() < aEnd
}

export const factInterval = (f: Pick<AuthoritativeFact, "validFrom" | "validUntil">): ValidityInterval => ({
  start: toInstant(String(f.validFrom)),
  end: f.validUntil === null ? null : toInstant(String(f.validUntil)),
})

// ---------------------------------------------------------------------------
// Fact validation + conflict detection
// ---------------------------------------------------------------------------
export const validateFactValue = (valueType: FactValueType, valueText: string): void => {
  const v = valueText.trim()
  if (v.length === 0) throw new Error("InvalidFactValue: value must not be empty")
  switch (valueType) {
    case "TEXT":
    case "ENUM":
      return
    case "NUMBER":
    case "CURRENCY": {
      if (!/^-?[\d,]*\.?\d+$/.test(v.replace(/[$€£¥\s]/g, ""))) {
        throw new Error(`InvalidFactValue: ${valueType} value ${valueText} is not numeric`)
      }
      return
    }
    case "BOOLEAN": {
      if (!/^(true|false|yes|no)$/i.test(v)) throw new Error(`InvalidFactValue: bad boolean ${valueText}`)
      return
    }
    case "DATE": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isNaN(Date.parse(v))) {
        throw new Error(`InvalidFactValue: bad date ${valueText}`)
      }
      return
    }
    case "URL": {
      try {
        const u = new URL(v)
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol")
      } catch {
        throw new Error(`InvalidFactValue: bad url ${valueText}`)
      }
      return
    }
  }
}

export const validateValidityWindow = (from: string, until: string | null): void => {
  const s = toInstant(from)
  if (until !== null) {
    const e = toInstant(until)
    if (!(s.getTime() < e.getTime())) throw new Error("InvalidValidityWindow: validFrom must be < validUntil")
  }
}

/** FACT_AUTHORITY_CONFLICT when same business/subject/predicate, both ACTIVE, overlapping validity. Never auto-picks a winner. */
export const detectAuthorityConflicts = (
  facts: ReadonlyArray<Pick<AuthoritativeFact, "id" | "businessId" | "subject" | "predicate" | "status" | "validFrom" | "validUntil">>,
): Array<{ readonly a: string; readonly b: string }> => {
  const out: Array<{ a: string; b: string }> = []
  const active = facts.filter((f) => f.status === "ACTIVE")
  for (let i = 0; i < active.length; i++) {
    const a = active[i]
    if (a === undefined) continue
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j]
      if (b === undefined) continue
      if (a.businessId !== b.businessId) continue
      if (a.subject !== b.subject || a.predicate !== b.predicate) continue
      if (intervalsOverlap(factInterval(a), factInterval(b))) out.push({ a: a.id, b: b.id })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// CheckRun transitions (terminal states immutable; retryable failures are
// retried boundedly by CheckRunner before a terminal FAILED is recorded)
// ---------------------------------------------------------------------------
export const canTransitionCheckRun = (from: CheckRunStatus, to: CheckRunStatus): boolean => {
  switch (from) {
    case "QUEUED":
      return to === "RUNNING"
    case "RUNNING":
      return to === "SUCCEEDED" || to === "FAILED"
    case "SUCCEEDED":
    case "FAILED":
      return false
  }
}

export const assertCheckTransition = (from: CheckRunStatus, to: CheckRunStatus): void => {
  if (!canTransitionCheckRun(from, to)) throw new Error(`InvalidCheckTransition: ${from} -> ${to}`)
}

/** Latest judgment head: the record no newer judgment supersedes.
 * Supersession is append-only (J2.supersedesId = J1.id); old rows are never
 * rewritten, so the head derives from the chain, not a mutable flag. */
export const latestJudgment = (
  judgments: ReadonlyArray<HumanJudgment>,
): HumanJudgment | null => {
  if (judgments.length === 0) return null
  const supersededIds = new Set(
    judgments.filter((j) => j.supersedesId !== null).map((j) => j.supersedesId as string),
  )
  const heads = judgments.filter((j) => !supersededIds.has(j.id as string))
  if (heads.length === 0) return null
  return heads.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null
}

/** Retryable provider failures use bounded Schedule; auth/malformed/contract never auto-retry. */
export const isRetryableFailure = (failure: FailureClass | null): boolean =>
  failure === "PROVIDER_RATE_LIMITED" || failure === "PROVIDER_UNAVAILABLE" || failure === "PROVIDER_TIMEOUT"
