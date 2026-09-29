// CheckRunner: claims one QUEUED run (FOR UPDATE SKIP LOCKED), invokes the
// Rust observation engine, persists raw evidence + immutable Observation,
// transitions RUNNING -> SUCCEEDED | FAILED. Failed attempts are permanent.
import { Context, Effect, Layer } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import pg from "pg"
import {
  CheckRunRepository,
  ObservationRepository,
  QuestionRepository,
} from "@ghostping/db"
import { RustObservationWorker } from "./rust-worker.js"

export class CheckRunner extends Context.Tag("CheckRunner")<
  CheckRunner,
  { readonly runOnce: () => Effect.Effect<boolean, SqlError> }
>() {}

export const CheckRunnerLive = Layer.effect(
  CheckRunner,
  Effect.gen(function*() {
    const runs = yield* CheckRunRepository
    const questions = yield* QuestionRepository
    const observations = yield* ObservationRepository
    const worker = yield* RustObservationWorker

    const runOnce = (): Effect.Effect<boolean, SqlError> =>
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
        const result = yield* worker
          .invoke({
            runId: claimed.id,
            provider: claimed.provider,
            model: claimed.requestedModel,
            prompt,
          })
          .pipe(Effect.exit)
        if (result._tag === "Success") {
          const r = result.value
          if (r.status === "succeeded") {
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
          } else {
            yield* runs.markFinished(
              claimed.id,
              "FAILED",
              (r.failure_class as string | null) ?? "UNKNOWN",
              (r.failure_detail_safe as string | null) ?? "worker reported failure",
            )
            yield* log("worker-failed")
          }
        } else {
          const cause = result.cause
          const detail = String(cause).slice(0, 500)
          const failureClass = detail.includes("ContractMismatch")
            ? "WORKER_CONTRACT_MISMATCH"
            : detail.includes("Timeout")
              ? "PROVIDER_TIMEOUT"
              : "WORKER_FAILED"
          yield* runs.markFinished(claimed.id, "FAILED", failureClass, detail)
          yield* log(`failed:${failureClass}`)
        }
        void questions
        return true
      })
    return { runOnce }
  }),
)

export const makeTestPool = (url: string) => new pg.Pool({ connectionString: url })
