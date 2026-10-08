// Provider execution stays outside persistence transactions. One registry,
// bounded typed retries, append-only evidence, and transactional success.
//
// Re-observation finalization: when a check run fulfills a durable
// re-observation intent, its lineage link commits atomically inside
// ObservationRepository.create (same transaction as the observation and
// the SUCCEEDED marking), so a crash can never leave a completed
// observation without its link or vice versa. The explicit finalize call
// below is an idempotent cover for any path where observation and
// completion committed without the link, and the sweeper at the top of
// every runOnce deterministically recovers SUCCEEDED runs with
// unfulfilled intents (bounded per iteration until drained).
//
// Exact failure windows:
// - Crash before the create transaction commits: the check stays RUNNING
//   with no observation and no link (pre-existing worker behavior for
//   crashes; identical to a check that never ran).
// - Crash after commit: observation, SUCCEEDED, and link are all durable
//   (one transaction); the cover call and sweeper are no-ops via
//   UNIQUE(issue_id, observation_id) + insert-or-select.
// - Provider timeout/auth/malformed (or missing question): the run is
//   marked FAILED, no observation is stored, no link is created, and the
//   intent row is retained append-only for a later recheck. Failure reads
//   as MEASUREMENT_FAILED downstream, never NO_OBSERVED_CHANGE: this
//   worker never derives outcomes at all.
import { Context, Effect, Layer, Option, Redacted, Schedule } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import {
  AssayRepository, CheckRunRepository, ObservationRepository, ProviderAttemptEvidenceRepository,
  hostedMeasurementContext, QuestionRepository, type ClaimScope, type RawDigestMismatch, type RowDecodeError,
} from "@openrecord/db"
import {
  ProviderRegistry, isProviderError, isRetryableProviderError, type ProviderError,
} from "@openrecord/providers"
import type { FailureClass } from "@openrecord/domain"
import type { MeasurementContextV1 } from "@openrecord/protocol"
export const MAX_PROVIDER_ATTEMPTS = 4
export const RetrySchedule = Schedule.intersect(Schedule.exponential("500 millis", 2), Schedule.recurs(3))
export const providerFailure = (error: ProviderError): { failureClass: FailureClass; detail: string } => {
  switch (error._tag) {
    case "ProviderAuth": return { failureClass: "PROVIDER_AUTH", detail: "provider rejected credentials" }
    case "ProviderRateLimited": return { failureClass: "PROVIDER_RATE_LIMITED", detail: "provider rate limited" }
    case "ProviderTimeout": return { failureClass: "PROVIDER_TIMEOUT", detail: "provider request timed out" }
    case "ProviderUnavailable": return { failureClass: "PROVIDER_UNAVAILABLE", detail: "provider unavailable" }
    case "ProviderMalformed": return { failureClass: "PROVIDER_MALFORMED", detail: "provider returned invalid or oversized bytes" }
    case "ProviderUnsupported": return { failureClass: "PROVIDER_UNSUPPORTED", detail: "provider or model unavailable for this request" }
    case "ProviderContractMismatch": return { failureClass: "PROVIDER_CONTRACT_MISMATCH", detail: "provider response did not match its contract" }
  }
}
export class CheckRunner extends Context.Tag("CheckRunner")<CheckRunner, {
  /** `scope` limits the claim to one business (tests); the loop is global. */
  readonly runOnce: (scope?: ClaimScope) => Effect.Effect<boolean, SqlError | RowDecodeError | RawDigestMismatch>
}>() {}
export const makeCheckRunnerLive = (retrySchedule: Schedule.Schedule<unknown, ProviderError | SqlError | RowDecodeError | RawDigestMismatch> = RetrySchedule) =>
  Layer.effect(CheckRunner, Effect.gen(function*() {
    const runs = yield* CheckRunRepository
    const questions = yield* QuestionRepository
    const observations = yield* ObservationRepository
    const evidence = yield* ProviderAttemptEvidenceRepository
    const providers = yield* ProviderRegistry
    const assay = yield* Effect.serviceOption(AssayRepository)
    return { runOnce: (scope?: ClaimScope) => Effect.gen(function*() {
      // Deterministic recovery before claiming new work, so an unfulfilled
      // intent from a completed run is linked even when the queue is idle.
      // Bounded (25) per iteration; returning true keeps polling until drained.
      const swept = yield* observations.sweepUnfulfilledReobservations(25)
      const claimed = yield* runs.claimOne(scope)
      if (!claimed) return swept > 0
      const log = (message: string, fields: Record<string, string | number | boolean | null> = {}) => Effect.logInfo(message).pipe(Effect.annotateLogs({
        business_id: claimed.businessId, check_run_id: claimed.id, provider: claimed.provider,
        requested_model: claimed.requestedModel, ...fields,
      }))
      yield* log("check claimed")
      const q = yield* questions.getScoped(claimed.businessId, claimed.questionId)
      if (!q) {
        yield* runs.markFinished(claimed.id, "FAILED", "UNKNOWN", "question unavailable")
        return true
      }
      if (claimed.assaySampleGroupId && Option.isNone(assay)) {
        yield* runs.markFinished(claimed.id, "FAILED", "PROVIDER_UNSUPPORTED", "assay execution configuration unavailable")
        return true
      }
      const sampling = Option.isSome(assay) ? yield* assay.value.requestForRun(claimed.id) : null
      const attemptOnce = Effect.gen(function*() {
        const attempt = yield* runs.recordAttempt(claimed.id)
        const started = Date.now()
        const result = yield* providers.observe({ runId: claimed.id, provider: claimed.provider, requestedModel: claimed.requestedModel, prompt: q.prompt, ...(sampling ?? {}) }).pipe(
          Effect.catchAll(error => Effect.gen(function*() {
            if (error.evidence) {
              const raw = Redacted.value(error.evidence)
              yield* evidence.record({
                checkRunId: claimed.id, businessId: claimed.businessId, attempt,
                failureClass: providerFailure(error).failureClass, status: error.status ?? null,
                bytes: raw.rawBytes, digest: raw.rawDigest, contentType: raw.rawContentType,
                responseMaxBytes: raw.responseMaxBytes,
              })
            }
            yield* log("provider attempt failed", { attempt, latency_ms: Date.now() - started, status: error._tag })
            return yield* Effect.fail(error)
          })),
        )
        yield* log("provider attempt succeeded", { attempt, latency_ms: Date.now() - started, status: "succeeded", requested_model: result.requestedModel })
        return result
      })
      let attempts = 0
      const result = yield* attemptOnce.pipe(
        // Keep the hard ceiling even when a test/custom Schedule is broader.
        Effect.tapError(() => Effect.sync(() => { attempts++ })),
        Effect.retry({ schedule: retrySchedule, while: error => attempts < MAX_PROVIDER_ATTEMPTS &&
          (isProviderError(error) && isRetryableProviderError(error)) }),
        Effect.either,
      )
      if (result._tag === "Left") {
        const error = result.left
        if (!isProviderError(error)) return yield* Effect.fail(error)
        const failure = providerFailure(error)
        yield* runs.markFinished(claimed.id, "FAILED", failure.failureClass, failure.detail)
        yield* log("check failed", { status: failure.failureClass })
        return true
      }
      const r = result.right
      let measurementContext: MeasurementContextV1 | null = null
      try {
        measurementContext = hostedMeasurementContext({ businessId: claimed.businessId, questionId: claimed.questionId,
          checkRunId: claimed.id, prompt: q.prompt, provider: r.provider, requestedModel: r.requestedModel,
          observedModel: r.observedModel, observedAt: r.collectedAt })
      } catch { /* Unsupported protocol surface stays unknown. */ }
      yield* observations.create({
        businessId: claimed.businessId, checkRunId: claimed.id, provider: r.provider,
        requestedModel: r.requestedModel, observedModel: r.observedModel, collectedAt: r.collectedAt,
        answerText: r.answerText, retrievalMode: r.retrievalMode, modelVersion: r.modelVersion ?? null,
        retrievalTool: r.retrievalTool ?? null, requestParameters: r.requestParameters, rawResponse: r.rawResponse,
        rawDigest: r.rawDigest, rawBytesHex: Buffer.from(r.rawBytes).toString("hex"), rawContentType: r.rawContentType,
        rawResponseMaxBytes: r.responseMaxBytes, providerMetadata: r.providerMetadata,
        surfaceIdentity: measurementContext?.surface ?? null, measurementContext, synthetic: r.synthetic,
        citations: r.citations, completeRun: true,
      })
      // Idempotent cover: the link normally already exists (committed
      // atomically inside create above). When no intent names this run, or
      // the run somehow completed without one, this stores nothing and
      // returns null. Crash/retry can never duplicate links: concurrent
      // finalizations serialize on UNIQUE(issue_id, observation_id) and the
      // follow-up select returns the single winner.
      yield* observations.finalizeReobservationForCheckRun(claimed.id)
      yield* log("check succeeded", { status: "SUCCEEDED" })
      return true
    }) }
  }))
export const CheckRunnerLive = makeCheckRunnerLive()
