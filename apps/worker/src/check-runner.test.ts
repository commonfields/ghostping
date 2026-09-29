import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { CheckRunner, CheckRunnerLive } from "./check-runner.js"
import { RustObservationWorker } from "./rust-worker.js"
import {
  CheckRunRepository,
  ObservationRepository,
  QuestionRepository,
} from "@ghostping/db"

// Test Layers: stub worker + stub repos prove CheckRunner orchestration
// (QUEUED -> RUNNING -> SUCCEEDED + immutable observation) without Postgres.
describe("CheckRunner", () => {
  it("claims a run, invokes worker, persists observation", async () => {
    let finished: { status: string } | null = null
    let createdObs = false
    const Runs = Layer.succeed(CheckRunRepository, {
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
        }),
      markRunning: () => Effect.void,
      markFinished: (_id: string, status: "SUCCEEDED" | "FAILED") =>
        Effect.sync(() => {
          finished = { status }
        }),
    })
    const Questions = Layer.succeed(QuestionRepository, {
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
    const Obs = Layer.succeed(ObservationRepository, {
      create: () =>
        Effect.sync(() => {
          createdObs = true
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
    const Worker = Layer.succeed(RustObservationWorker, {
      invoke: () =>
        Effect.succeed({
          contract_version: "ghostping-worker-result-v1" as const,
          run_id: "run-1",
          status: "succeeded" as const,
          provider: "mock",
          requested_model: null,
          observed_model: "mock-v1",
          collected_at: new Date().toISOString(),
          answer_text: "Northstar costs $29/month.",
          retrieval_mode: "unknown" as const,
          citations: [],
          raw_digest: "d",
          raw_response: { answer: "x" },
          failure_class: null,
          failure_detail_safe: null,
        }),
    })
    const RunnerTest = CheckRunnerLive.pipe(
      Layer.provide(Worker),
      Layer.provide(Layer.mergeAll(Runs, Questions, Obs)),
    )
    const did = await Effect.runPromise(
      Effect.flatMap(CheckRunner, (r) => r.runOnce()).pipe(Effect.provide(RunnerTest)),
    )
    expect(did).toBe(true)
    expect(createdObs).toBe(true)
    expect((finished as unknown as { status: string } | null)?.status).toBe("SUCCEEDED")
  })
})
