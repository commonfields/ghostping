// CheckRunner orchestration + bounded retry semantics, via deterministic
// test Layers (no Postgres, no real binary, no timing luck). The retry
// Schedule under test is Schedule.recurs(3): same bound as production,
// without delays.
import { describe, expect, it } from "vitest"
import { Effect, Layer, Schedule } from "effect"
import {
  CheckRunner,
  classifyInvokeError,
  classifyResultFailure,
  makeCheckRunnerLive,
  MAX_WORKER_ATTEMPTS,
  RetryableWorkerFailure,
  TerminalWorkerFailure,
} from "./check-runner.js"
import {
  ProviderTimeout,
  RustObservationWorker,
  WorkerContractMismatch,
  WorkerFailed,
} from "./rust-worker.js"
import {
  CheckRunRepository,
  ObservationRepository,
  QuestionRepository,
} from "@ghostping/db"
import type { WorkerResultV1 } from "@ghostping/contracts"

const NoDelayRetry = Schedule.recurs(3)

const okResult = (overrides: Partial<WorkerResultV1> = {}): WorkerResultV1 => ({
  contract_version: "ghostping-worker-result-v1",
  run_id: "run-1",
  status: "succeeded",
  provider: "mock",
  requested_model: null,
  observed_model: "mock-v1",
  collected_at: new Date().toISOString(),
  answer_text: "Northstar costs $29/month.",
  retrieval_mode: "unknown",
  citations: [],
  raw_digest: "d",
  raw_response: { answer: "x" },
  failure_class: null,
  failure_detail_safe: null,
  ...overrides,
})

const failedResult = (failureClass: string, detail: string): WorkerResultV1 =>
  okResult({ status: "failed", answer_text: null, failure_class: failureClass, failure_detail_safe: detail })

interface RunState {
  attempts: number
  finished: { status: string; failureClass: string | null } | null
}

// Queued run stub: claimOne succeeds once, then the queue is empty.
const RunsStub = (state: RunState) =>
  Layer.succeed(CheckRunRepository, {
    enqueue: () => Effect.dieMessage("unused"),
    listByBusiness: () => Effect.succeed([]),
    getScoped: () => Effect.succeed(null),
    claimOne: () =>
      Effect.succeed({
        id: "run-1",
        businessId: "b1",
        questionId: "q1",
        provider: "mock",
        requestedModel: null,
        status: "QUEUED",
        queuedAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        failureClass: null,
        failureDetailSafe: null,
        attemptCount: 0,
      }),
    markRunning: () => Effect.void,
    recordAttempt: () =>
      Effect.sync(() => {
        state.attempts += 1
        return state.attempts
      }),
    markFinished: (id: string, status: "SUCCEEDED" | "FAILED", failureClass: string | null) =>
      Effect.sync(() => {
        void id
        state.finished = { status, failureClass }
      }),
  })

const QuestionsStub = Layer.succeed(QuestionRepository, {
  create: () => Effect.dieMessage("unused"),
  listByBusiness: () => Effect.succeed([]),
  getScoped: () =>
    Effect.succeed({
      id: "q1",
      businessId: "b1",
      label: null,
      prompt: "How much does Northstar cost?",
      origin: "BUSINESS_OWNER",
      active: true,
      createdAt: new Date().toISOString(),
    }),
})

const ObsStub = (state: { created: boolean }) =>
  Layer.succeed(ObservationRepository, {
    create: () =>
      Effect.sync(() => {
        state.created = true
        return {
          id: "o1",
          businessId: "b1",
          checkRunId: "run-1",
          provider: "mock",
          requestedModel: null,
          observedModel: "mock-v1",
          collectedAt: new Date().toISOString(),
          answerText: "Northstar costs $29/month.",
          retrievalMode: "unknown",
          rawEvidenceId: "r1",
          rawDigest: "d",
          citations: [],
        }
      }),
    getScoped: () => Effect.succeed(null),
    getByCheckRun: () => Effect.succeed(null),
  })

const runCase = async (
  script: Array<WorkerResultV1 | WorkerContractMismatch | WorkerFailed | ProviderTimeout>,
): Promise<{ attempts: number; finished: { status: string; failureClass: string | null } | null; obs: boolean }> => {
  const runState: RunState = { finished: null, attempts: 0 }
  const obsState = { created: false }
  let calls = 0
  const Worker = Layer.succeed(RustObservationWorker, {
    invoke: () => {
      const step = script[Math.min(calls, script.length - 1)] as WorkerResultV1 | WorkerContractMismatch | WorkerFailed | ProviderTimeout
      calls += 1
      if (
        step instanceof WorkerContractMismatch ||
        step instanceof WorkerFailed ||
        step instanceof ProviderTimeout
      ) {
        return Effect.fail(step)
      }
      return Effect.succeed(step)
    },
  })
  const RunnerTest = makeCheckRunnerLive(NoDelayRetry).pipe(
    Layer.provide(Worker),
    Layer.provide(Layer.mergeAll(RunsStub(runState), QuestionsStub, ObsStub(obsState))),
  )
  const did = await Effect.runPromise(
    Effect.flatMap(CheckRunner, (r) => r.runOnce()).pipe(Effect.provide(RunnerTest)),
  )
  if (!did) throw new Error("expected runOnce to claim work")
  return { attempts: runState.attempts, finished: runState.finished, obs: obsState.created }
}

describe("CheckRunner retry taxonomy", () => {
  it("documents the attempt bound", () => {
    expect(MAX_WORKER_ATTEMPTS).toBe(4)
  })

  it("claims a run, invokes worker, persists observation", async () => {
    const out = await runCase([okResult()])
    expect(out.finished?.status).toBe("SUCCEEDED")
    expect(out.obs).toBe(true)
    expect(out.attempts).toBe(1)
  })

  it("rate-limited twice then success: 3 attempts, SUCCEEDED", async () => {
    const out = await runCase([
      failedResult("PROVIDER_RATE_LIMITED", "429 rate_limited"),
      failedResult("PROVIDER_RATE_LIMITED", "429 rate_limited"),
      okResult(),
    ])
    expect(out.attempts).toBe(3)
    expect(out.finished?.status).toBe("SUCCEEDED")
    expect(out.obs).toBe(true)
  })

  it("timeout then success is retried", async () => {
    const out = await runCase([new ProviderTimeout({ detail: "worker timeout after 1000ms" }), okResult()])
    expect(out.attempts).toBe(2)
    expect(out.finished?.status).toBe("SUCCEEDED")
  })

  it("auth failure: 1 attempt, FAILED, not retried", async () => {
    const out = await runCase([failedResult("PROVIDER_AUTH", "401 unauthorized")])
    expect(out.attempts).toBe(1)
    expect(out.finished?.status).toBe("FAILED")
    expect(out.finished?.failureClass).toBe("PROVIDER_AUTH")
    expect(out.obs).toBe(false)
  })

  it("malformed result: 1 attempt, FAILED, not retried", async () => {
    const out = await runCase([failedResult("PROVIDER_MALFORMED", "bad json shape")])
    expect(out.attempts).toBe(1)
    expect(out.finished?.status).toBe("FAILED")
    expect(out.finished?.failureClass).toBe("PROVIDER_MALFORMED")
  })

  it("contract mismatch: 1 attempt, FAILED, not retried", async () => {
    const out = await runCase([new WorkerContractMismatch({ detail: "bad contract" })])
    expect(out.attempts).toBe(1)
    expect(out.finished?.status).toBe("FAILED")
    expect(out.finished?.failureClass).toBe("WORKER_CONTRACT_MISMATCH")
  })

  it("persistent retryable failure: bounded at 4 attempts, FAILED", async () => {
    const out = await runCase([
      failedResult("PROVIDER_UNAVAILABLE", "503 unavailable"),
      failedResult("PROVIDER_UNAVAILABLE", "503 unavailable"),
      failedResult("PROVIDER_UNAVAILABLE", "503 unavailable"),
      failedResult("PROVIDER_UNAVAILABLE", "503 unavailable"),
      failedResult("PROVIDER_UNAVAILABLE", "503 unavailable"),
    ])
    expect(out.attempts).toBe(MAX_WORKER_ATTEMPTS)
    expect(out.finished?.status).toBe("FAILED")
    expect(out.finished?.failureClass).toBe("PROVIDER_UNAVAILABLE")
    expect(out.obs).toBe(false)
  })
})

describe("failure classification prefers typed classes", () => {
  it("classifies result failures", () => {
    expect(classifyResultFailure("PROVIDER_RATE_LIMITED", "x")).toBeInstanceOf(RetryableWorkerFailure)
    expect(classifyResultFailure("PROVIDER_UNAVAILABLE", "x")).toBeInstanceOf(RetryableWorkerFailure)
    expect(classifyResultFailure("PROVIDER_TIMEOUT", "x")).toBeInstanceOf(RetryableWorkerFailure)
    expect(classifyResultFailure("PROVIDER_AUTH", "x")).toBeInstanceOf(TerminalWorkerFailure)
    expect(classifyResultFailure("PROVIDER_MALFORMED", "x")).toBeInstanceOf(TerminalWorkerFailure)
    expect(classifyResultFailure("WORKER_CONTRACT_MISMATCH", "x")).toBeInstanceOf(TerminalWorkerFailure)
    expect(classifyResultFailure("WORKER_FAILED", "x")).toBeInstanceOf(TerminalWorkerFailure)
    // Unknown strings fail closed as non-retryable.
    expect(classifyResultFailure("SOME_NEW_CLASS", "x")).toBeInstanceOf(TerminalWorkerFailure)
  })

  it("classifies thrown worker errors by typed class, not message text", () => {
    expect(classifyInvokeError(new ProviderTimeout({ detail: "slow" }))).toBeInstanceOf(RetryableWorkerFailure)
    expect(classifyInvokeError(new WorkerContractMismatch({ detail: "timeout-like text" }))).toBeInstanceOf(
      TerminalWorkerFailure,
    )
    expect(classifyInvokeError(new WorkerFailed({ detail: "econnreset" }))).toBeInstanceOf(TerminalWorkerFailure)
  })
})
