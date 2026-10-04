// Recorded actions for one issue: account-scoped reads plus the product
// write path for the ACT stage. The repository stays the only writer;
// these helpers only confirm the claim belongs to the business before
// delegating. Unknown ids and claims from another business both read as
// null, so callers answer 404 without leaking existence.
import { Effect } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import {
  ClaimRepository,
  InterventionCorrectionInvalid,
  InterventionRepository,
  type InterventionInput,
  type InterventionRow,
  type RowDecodeError,
} from "@ghostping/db"

export interface RecordInterventionInput {
  readonly type: InterventionInput["type"]
  readonly target: string
  readonly performedAt: string
  readonly notes: string | null
  readonly evidenceBeforeDigest: string | null
  readonly evidenceAfterDigest: string | null
}

const scopedClaim = (businessId: string, claimId: string) =>
  Effect.gen(function*() {
    const claims = yield* ClaimRepository
    return yield* claims.getScoped(businessId, claimId)
  })

/** Recorded actions for one issue, or null when the claim is unknown here. */
export const loadInterventions = (
  businessId: string,
  claimId: string,
): Effect.Effect<
  ReadonlyArray<InterventionRow> | null,
  SqlError | RowDecodeError,
  ClaimRepository | InterventionRepository
> =>
  Effect.gen(function*() {
    if (!(yield* scopedClaim(businessId, claimId))) return null
    const repo = yield* InterventionRepository
    return yield* repo.listByIssue(businessId, claimId)
  })

/**
 * Append one recorded action for an issue, or null when the claim is
 * unknown here. The actor is always HUMAN on this route; a correction
 * is a separate append-only row and stays out of scope for this helper.
 */
export const recordIntervention = (
  businessId: string,
  claimId: string,
  input: RecordInterventionInput,
): Effect.Effect<
  InterventionRow | null,
  SqlError | RowDecodeError | InterventionCorrectionInvalid,
  ClaimRepository | InterventionRepository
> =>
  Effect.gen(function*() {
    if (!(yield* scopedClaim(businessId, claimId))) return null
    const repo = yield* InterventionRepository
    return yield* repo.append({
      businessId,
      issueIds: [claimId],
      type: input.type,
      target: input.target,
      performedAt: input.performedAt,
      actor: "HUMAN",
      actorId: null,
      notes: input.notes,
      evidenceBeforeDigest: input.evidenceBeforeDigest,
      evidenceAfterDigest: input.evidenceAfterDigest,
      supersedesId: null,
      correctionReason: null,
    })
  })
