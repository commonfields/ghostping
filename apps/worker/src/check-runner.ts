// CheckRunner: claims one QUEUED run (atomic single-statement ownership),
// invokes the Rust observation engine with a bounded retry policy, persists
// raw evidence + immutable Observation, transitions RUNNING -> SUCCEEDED |
// FAILED. Every real worker invocation increments check_runs.attempt_count.
//
// Retry semantics (initial attempt + at most 3 retries = at most 4 worker
// invocations). Retryable: PROVIDER_RATE_LIMITED, PROVIDER_UNAVAILABLE,
// PROVIDER_TIMEOUT (typed failure classes only). Never retried:
// PROVIDER_AUTH, PROVIDER_MALFORMED, WORKER_CONTRACT_MISMATCH,
// WORKER_FAILED, unsupported provider/model, invalid job contract.
import { Context, Data, Effect, Layer, type Schedule } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import pg from "pg"
import {
  CheckRunRepository,
  ObservationRepository,
  QuestionRepository,
  type RawDigestMismatch,
} from "@ghostping/db"
import { isRetryableFailure, type FailureClass } from "@ghostping/domain"
import type { WorkerResultV1 } from "@ghostping/contracts"
import {
  ProviderTimeout,
  RetrySchedule,
  RustObservationWorker,
  WorkerContractMismatch,
  WorkerFailed,
} from "./rust-worker.js"

// Initial attempt + maximum 3 retries = maximum 4 worker invocations.
export const MAX_WORKER_ATTEMPTS = 4

type WorkerInvokeError = WorkerContractMismatch | WorkerFailed | ProviderTimeout

// A retryable provider failure: Effect.retry keeps going while this surfaces.
export class RetryableWorkerFailure extends Data.TaggedError("RetryableWorkerFailure")<{
  readonly failureClass: FailureClass
  readonly detail: string
}> {}

// A terminal failure: Effect.retry stops immediately and the run is FAILED.
export class TerminalWorkerFailure extends Data.TaggedError("TerminalWorkerFailure")<{
  readonly failureClass: FailureClass
  readonly detail: string
}> {}

// Normalize the Rust worker's string failure_class to the typed taxonomy.
// Unknown strings fail closed as non-retryable WORKER_FAILED-class detail.
const KNOWN_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_AUTH",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_MALFORMED",
  "WORKER_FAILED",
  "WORKER_CONTRACT_MISMATCH",
  "UNKNOWN",
])

export const toFailureClass = (raw: string | null): FailureClass => {
  if (raw !== null && KNOWN_FAILURE_CLASSES.has(raw)) return raw as FailureClass
  if (raw === "NONE") return "UNKNOWN"
  return "UNKNOWN"
}

export const classifyResultFailure = (
  failureClass: string | null,
  detail: string | null,
): RetryableWorkerFailure | TerminalWorkerFailure => {
  const typed = toFailureClass(failureClass)
  const safe = (detail ?? "worker reported failure").slice(0, 500)
  return isRetryableFailure(typed)
    ? new RetryableWorkerFailure({ failureClass: typed, detail: safe })
    : new TerminalWorkerFailure({ failureClass: typed, detail: safe })
}

export const classifyInvokeError = (
  error: WorkerInvokeError,
): RetryableWorkerFailure | TerminalWorkerFailure => {
  // Typed error classes only; never infer retryability from free text here.
  if (error instanceof ProviderTimeout) {
    return new RetryableWorkerFailure({
      failureClass: "PROVIDER_TIMEOUT",
      detail: (error.detail ?? "worker timeout").slice(0, 500),
    })
  }
  if (error instanceof WorkerContractMismatch) {
    return new TerminalWorkerFailure({
      failureClass: "WORKER_CONTRACT_MISMATCH",
      detail: (error.detail ?? "worker contract mismatch").slice(0, 500),
    })
  }
  return new TerminalWorkerFailure({
    failureClass: "WORKER_FAILED",
    detail: (error.detail ?? "worker failed").slice(0, 500),
  })
}

export class CheckRunner extends Context.Tag("CheckRunner")<
  CheckRunner,
  { readonly runOnce: () => Effect.Effect<boolean, SqlError | RawDigestMismatch> }
>() {}

export const makeCheckRunnerLive = (
  retrySchedule: Schedule.Schedule<
    unknown,
    RetryableWorkerFailure | TerminalWorkerFailure | SqlError
  > = RetrySchedule,
) =>
  Layer.effect(
    CheckRunner,
    Effect.gen(function*() {
      const runs = yield* CheckRunRepository
      const questions = yield* QuestionRepository
      const observations = yield* ObservationRepository
      const worker = yield* RustObservationWorker

      const runOnce = (): Effect.Effect<boolean, SqlError | RawDigestMismatch> =>
        Effect.gen(function*() {
          const claimed = yield* runs.claimOne()
          if (!claimed) return false
          const log = (msg: string) =>
            Effect.sync(() =>
              console.log(
                JSON.stringify({
                  level: "info",
                  accountHint: "hosted",
                  business_id: claimed.businessId,
                  check_run_id: claimed.id,
                  provider: claimed.provider,
                  msg,
                }),
              ),
            )
          yield* log("claimed")
          // Load question prompt via repository (worker never sees account internals).
          const q = yield* questions.getScoped(claimed.businessId, claimed.questionId)
          const prompt = q?.prompt ?? ""
          const job = {
            runId: claimed.id,
            provider: claimed.provider,
            model: claimed.requestedModel,
            prompt,
          }

          // One real worker invocation. attempt_count increments first so
          // every actual invocation is observable even if the process dies.
          const attemptOnce: Effect.Effect<
            WorkerResultV1,
            RetryableWorkerFailure | TerminalWorkerFailure | SqlError
          > = Effect.gen(function*() {
            yield* runs.recordAttempt(claimed.id)
            const result = yield* worker.invoke(job).pipe(
              Effect.mapError(
                (e): RetryableWorkerFailure | TerminalWorkerFailure => classifyInvokeError(e),
              ),
            )
            if (result.status === "succeeded") return result
            return yield* Effect.fail(classifyResultFailure(result.failure_class, result.failure_detail_safe))
          })

          // Bounded retry: RetrySchedule (max 3 retries) composed here, and
          // only RetryableWorkerFailure keeps retrying. Terminal failures
          // propagate on first occurrence. SqlError (e.g. recordAttempt
          // failing) is never swallowed: it propagates to the caller.
          return yield* attemptOnce.pipe(
            Effect.retry({
              schedule: retrySchedule,
              while: (e) => e._tag === "RetryableWorkerFailure",
            }),
            Effect.matchCauseEffect({
              onFailure: (cause) => {
                if (cause._tag === "Fail") {
                  const failure = cause.error
                  if (
                    failure instanceof RetryableWorkerFailure ||
                    failure instanceof TerminalWorkerFailure
                  ) {
                    return Effect.gen(function*() {
                      yield* runs.markFinished(
                        claimed.id,
                        "FAILED",
                        failure.failureClass,
                        failure.detail,
                      )
                      yield* log(`failed:${failure.failureClass}`)
                      return true
                    })
                  }
                  // SqlError from recordAttempt: propagate typed, never swallow.
                  return Effect.fail(failure)
                }
                // Non-Fail causes (defect/interruption) carry no failure
                // values; re-raise preserving the cause.
                return Effect.failCause(cause) as Effect.Effect<never, never>
              },
              onSuccess: (r) =>
                Effect.gen(function*() {
                  yield* observations.create({
                    businessId: claimed.businessId,
                    checkRunId: claimed.id,
                    provider: r.provider,
                    requestedModel: r.requested_model,
                    observedModel: r.observed_model,
                    collectedAt: r.collected_at,
                    answerText: r.answer_text ?? "",
                    retrievalMode: r.retrieval_mode,
                    rawResponse: r.raw_response,
                    rawDigest: r.raw_digest,
                    citations: r.citations,
                  })
                  yield* runs.markFinished(claimed.id, "SUCCEEDED", null, null)
                  yield* log("succeeded")
                  return true
                }),
            }),
          )
        })
      return { runOnce }
    }),
  )

export const CheckRunnerLive = makeCheckRunnerLive()

export const makeTestPool = (url: string) => new pg.Pool({ connectionString: url })
