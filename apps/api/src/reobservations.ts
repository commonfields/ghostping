// Durable re-check requests for one issue: account-scoped reads plus the
// product write path for the RECHECK stage. The repositories stay the only
// writers; these helpers only confirm the claim belongs to the business
// before delegating. Unknown ids and claims from another business both read
// as null, so callers answer 404 without leaking existence.
//
// Everything the recheck needs (original observation, prior check run,
// question, provider, requested model) is derived server-side from the
// issue lineage. The request body carries at most an optional
// interventionId, so prompt/question/provider/model substitution is
// impossible by construction. Responses describe what was observed, never
// why it happened: attempts list intents, check statuses, and finalized
// lineage links only. Outcomes and comparisons stay derived at read time
// (see issue-loop.ts), never stored or asserted here.
import { Effect } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import {
  CheckRunRepository,
  ClaimRepository,
  ObservationRepository,
  ReobservationAlreadyActive,
  ReobservationIntentRepository,
  ReobservationInterventionMismatch,
  ReobservationOriginalObservationMismatch,
  ReobservationRepository,
  type CheckRunRow,
  type ReobservationIntentRow,
  type ReobservationRow,
  type RowDecodeError,
} from "@ghostping/db"

export interface RequestRecheckInput {
  readonly interventionId: string | null
}

export interface RecheckAttempt {
  readonly intent: ReobservationIntentRow
  readonly checkRun: CheckRunRow | null
  readonly observationId: string | null
  readonly reobservation: ReobservationRow | null
}

const scopedClaim = (businessId: string, claimId: string) =>
  Effect.gen(function*() {
    const claims = yield* ClaimRepository
    return yield* claims.getScoped(businessId, claimId)
  })

/**
 * Re-check attempts for one issue, oldest first, or null when the claim is
 * unknown here. Each attempt joins its durable intent to the fulfilling
 * check run's status and, once the worker finalizes it, the lineage link.
 * A FAILED check reads with its failure status and no link; the intent row
 * is retained (append-only), which is how the attempt stays PENDING for a
 * later successful recheck instead of reading as unchanged.
 */
export const listRecheckAttempts = (
  businessId: string,
  claimId: string,
): Effect.Effect<
  ReadonlyArray<RecheckAttempt> | null,
  SqlError | RowDecodeError,
  ClaimRepository | CheckRunRepository | ObservationRepository | ReobservationIntentRepository | ReobservationRepository
> =>
  Effect.gen(function*() {
    if (!(yield* scopedClaim(businessId, claimId))) return null
    const intents = yield* ReobservationIntentRepository
    const rows = yield* intents.listByIssue(businessId, claimId)
    const runs = yield* CheckRunRepository
    const observations = yield* ObservationRepository
    const links = yield* ReobservationRepository
    const allLinks = yield* links.listByIssue(businessId, claimId)
    const out: Array<RecheckAttempt> = []
    for (const intent of rows) {
      const checkRun = yield* runs.getScoped(businessId, intent.checkRunId)
      const observation = yield* observations.getByCheckRun(intent.checkRunId)
      const observationId = observation?.id ?? null
      const reobservation =
        observationId === null ? null : (allLinks.find((l) => l.observationId === observationId) ?? null)
      out.push({ intent, checkRun, observationId, reobservation })
    }
    return out
  })

/**
 * Queue one recheck for an issue, or null when the claim is unknown here.
 * Creation is atomic: the QUEUED check run and its durable intent commit in
 * one transaction (ReobservationIntentRepository.enqueueReobservation), so a
 * re-observation run can never exist without its intent. Question, provider,
 * and requested model are derived from the issue lineage inside that
 * transaction, never taken from the client. The authenticated user id is
 * supplied explicitly by the route. An unrelated intervention fails with
 * ReobservationInterventionMismatch and a duplicate active attempt with
 * ReobservationAlreadyActive (409 at the route), never 500.
 */
export const requestRecheck = (
  businessId: string,
  claimId: string,
  userId: string,
  input: RequestRecheckInput,
): Effect.Effect<
  { readonly intent: ReobservationIntentRow; readonly checkRun: CheckRunRow } | null,
  SqlError | RowDecodeError | ReobservationInterventionMismatch | ReobservationOriginalObservationMismatch | ReobservationAlreadyActive,
  ClaimRepository | ObservationRepository | ReobservationIntentRepository
> =>
  Effect.gen(function*() {
    const claim = yield* scopedClaim(businessId, claimId)
    if (!claim) return null
    const observations = yield* ObservationRepository
    const original = yield* observations.getScoped(businessId, claim.observationId)
    if (!original) return null
    const intents = yield* ReobservationIntentRepository
    return yield* intents.enqueueReobservation({
      businessId,
      issueId: claimId,
      originalObservationId: claim.observationId,
      interventionId: input.interventionId,
      createdByUserId: userId,
    })
  })
