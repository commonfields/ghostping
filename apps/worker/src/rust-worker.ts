// Narrow, secure Rust worker boundary.
// - spawns executable directly (no shell interpolation)
// - JSON via stdin, stdout reserved for result JSON, stderr captured separately
// - timeout enforced, run_id equality + contract version validated
// - provider credentials come from environment, never in the job payload
import { Context, Data, Effect, Layer, Schedule } from "effect"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  decodeWorkerResult,
  encodeWorkerJob,
  JOB_CONTRACT_VERSION,
  RESULT_CONTRACT_VERSION,
  type WorkerJobV1,
  type WorkerResultV1,
} from "@ghostping/contracts"

export class WorkerContractMismatch extends Data.TaggedError("WorkerContractMismatch")<{
  readonly detail?: string | undefined
}> {}

export class WorkerFailed extends Data.TaggedError("WorkerFailed")<{
  readonly detail?: string | undefined
}> {}

export class ProviderTimeout extends Data.TaggedError("ProviderTimeout")<{
  readonly detail?: string | undefined
}> {}

export interface RustInvokeInput {
  readonly runId: string
  readonly provider: string
  readonly model: string | null
  readonly prompt: string
}

export class RustObservationWorker extends Context.Tag("RustObservationWorker")<
  RustObservationWorker,
  {
    readonly invoke: (
      input: RustInvokeInput,
    ) => Effect.Effect<WorkerResultV1, WorkerContractMismatch | WorkerFailed | ProviderTimeout>
  }
>() {}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex")

const runOnce = (workerPath: string, timeoutMs: number, job: WorkerJobV1): Effect.Effect<string, WorkerFailed | ProviderTimeout> =>
  Effect.async<string, WorkerFailed | ProviderTimeout>((resume) => {
    const child = spawn(workerPath, [], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try {
          child.kill("SIGKILL")
        } catch {
          // ignore
        }
        resume(Effect.fail(new ProviderTimeout({ detail: `worker timeout after ${timeoutMs}ms` })))
      }
    }, timeoutMs)
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    child.on("error", (e) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        resume(Effect.fail(new WorkerFailed({ detail: `spawn failed: ${e.message} ${stderr}` })))
      }
    })
    child.on("close", (code) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        if (code === 0) resume(Effect.succeed(stdout))
        else resume(Effect.fail(new WorkerFailed({ detail: `exit ${code}: ${stderr.slice(0, 500)}` })))
      }
    })
    try {
      child.stdin.write(JSON.stringify(encodeWorkerJob(job)))
      child.stdin.end()
    } catch (e) {
      if (!done) {
        done = true
        clearTimeout(timer)
        resume(Effect.fail(new WorkerFailed({ detail: `stdin failed: ${String(e)}` })))
      }
    }
  })

export const RustObservationWorkerLive = (workerPath: string, timeoutMs = 60_000) =>
  Layer.succeed(RustObservationWorker, {
    invoke: (input) =>
      Effect.gen(function*() {
        const job: WorkerJobV1 = {
          contract_version: JOB_CONTRACT_VERSION,
          run_id: input.runId,
          provider: input.provider,
          model: input.model,
          prompt: input.prompt,
        }
        const stdout = yield* runOnce(workerPath, timeoutMs, job)
        let parsed: unknown
        try {
          parsed = JSON.parse(stdout)
        } catch {
          return yield* Effect.fail(
            new WorkerContractMismatch({ detail: `stdout is not JSON: ${stdout.slice(0, 300)}` }),
          )
        }
        const result = yield* Effect.try({
          try: () => decodeWorkerResult(parsed),
          catch: (e) =>
            new WorkerContractMismatch({ detail: `result-v1 validation failed: ${String(e)}` }),
        })
        if (result.contract_version !== RESULT_CONTRACT_VERSION) {
          return yield* Effect.fail(
            new WorkerContractMismatch({ detail: `bad contract ${String(result.contract_version)}` }),
          )
        }
        if (result.run_id !== input.runId) {
          return yield* Effect.fail(
            new WorkerContractMismatch({
              detail: `run_id mismatch: expected ${input.runId}, got ${result.run_id}`,
            }),
          )
        }
        return result
      }),
  })

// Retry policy: bounded Schedule. Retryable = 429/5xx/transient network
// surfaced as WorkerFailed with retryable detail; auth/malformed/contract
// mismatch never auto-retry.
export const isRetryableWorkerFailure = (detailSafe: string | null): boolean => {
  if (!detailSafe) return false
  const d = detailSafe.toLowerCase()
  return (
    d.includes("rate_limited") || d.includes("rate limited") || d.includes("429") ||
    d.includes("5xx") || d.includes("unavailable") || d.includes("timeout") ||
    d.includes("temporar") || d.includes("network") || d.includes("econn")
  )
}

export const RetrySchedule = Schedule.intersect(
  Schedule.exponential("500 millis", 2),
  Schedule.recurs(3),
)
