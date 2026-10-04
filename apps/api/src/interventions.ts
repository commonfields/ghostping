// Recorded actions for one issue: account-scoped reads plus the product
// write path for the ACT stage. The repository stays the only writer;
// these helpers only confirm the claim belongs to the business before
// delegating. Unknown ids and claims from another business both read as
// null, so callers answer 404 without leaking existence.
import { Effect } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import {
  ClaimRepository,
  InterventionBindingRepository,
  InterventionCorrectionInvalid,
  InterventionRepository,
  ProductReadRepository,
  type InterventionInput,
  type InterventionRow,
  type RowDecodeError,
} from "@ghostping/db"

export interface RecordInterventionInput {
  readonly type: InterventionInput["type"]
  readonly target: string
  readonly performedAt: string
  readonly notes: string | null
  readonly sourceBindingId: string | null
}

const scopedClaim = (businessId: string, claimId: string) =>
  Effect.gen(function*() {
    const claims = yield* ClaimRepository
    return yield* claims.getScoped(businessId, claimId)
  })

// ProductReadRepository declares its failure channel as unknown, but the
// live layer only fails with SqlError | RowDecodeError (explicit SQL plus
// row decoding, like every other repository). Narrow it so this module's
// signatures stay precise.
const asDbEffect = <A>(fx: Effect.Effect<A, unknown>): Effect.Effect<A, SqlError | RowDecodeError> =>
  fx as Effect.Effect<A, SqlError | RowDecodeError>

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
 * unknown here. The actor is always HUMAN on this route and the actor id is
 * always the authenticated user: the HTTP boundary owns identity, so the
 * caller supplies it explicitly and request JSON can never spoof it (the
 * contract schema has no actor fields). A correction is a separate
 * append-only row and stays out of scope for this helper.
 *
 * Optional source linkage: when `sourceBindingId` is set, the binding must
 * belong to this business (unknown and cross-tenant bindings both read as
 * null, so callers answer 404 without leaking existence). The best known
 * pre-intervention evidence is then the latest successful source
 * observation of that binding's target with completed_at <= performed_at;
 * its id is persisted (or NULL when none exists yet) — never manufactured
 * from current values, never hashed from URLs.
 *
 * Ordering (InterventionRepository.append is untouched): the intervention
 * appends first (the link's FK requires it), then the link row follows in
 * the same helper. If the link insert fails — only possible on a race the
 * pre-checks missed, since the trigger re-checks tenancy — the intervention
 * remains as an unlinked action (UNKNOWN downstream), never a rewritten row.
 */
export const recordIntervention = (
  businessId: string,
  claimId: string,
  actorId: string,
  input: RecordInterventionInput,
): Effect.Effect<
  InterventionRow | null,
  SqlError | RowDecodeError | InterventionCorrectionInvalid,
  ClaimRepository | InterventionRepository | InterventionBindingRepository | ProductReadRepository
> =>
  Effect.gen(function*() {
    if (!(yield* scopedClaim(businessId, claimId))) return null
    let beforeSourceObservationId: string | null = null
    if (input.sourceBindingId !== null) {
      const reads = yield* ProductReadRepository
      const binding = yield* asDbEffect(reads.binding(businessId, input.sourceBindingId))
      if (!binding) return null
      const observations = yield* asDbEffect(reads.observations(businessId))
      const candidates = observations
        .filter((o) =>
          o.sourceTargetId === binding.sourceTargetId
          && (o.collectionState === "FETCHED" || o.collectionState === "NOT_MODIFIED")
          && o.failure === null
          && o.completedAt <= input.performedAt,
        )
        .sort((a, b) => (a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : a.id < b.id ? -1 : 1))
      beforeSourceObservationId = candidates.at(-1)?.id ?? null
    }
    const repo = yield* InterventionRepository
    const row = yield* repo.append({
      businessId,
      issueIds: [claimId],
      type: input.type,
      target: input.target,
      performedAt: input.performedAt,
      actor: "HUMAN",
      actorId,
      notes: input.notes,
      evidenceBeforeDigest: null,
      evidenceAfterDigest: null,
      supersedesId: null,
      correctionReason: null,
    })
    if (input.sourceBindingId !== null) {
      const links = yield* InterventionBindingRepository
      yield* links.linkInterventionBinding({
        businessId,
        interventionId: row.id,
        sourceBindingId: input.sourceBindingId,
        beforeSourceObservationId,
      })
    }
    return row
  })
