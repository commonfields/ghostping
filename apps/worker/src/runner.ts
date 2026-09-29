import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { NodeRuntime } from "@effect/platform-node"
import {
  CheckRunRepositoryLive,
  ObservationRepositoryLive,
  QuestionRepositoryLive,
} from "@ghostping/db"
import { CheckRunner, CheckRunnerLive } from "./check-runner.js"
import { RustObservationWorkerLive } from "./rust-worker.js"

const databaseUrl = process.env["DATABASE_URL"] ?? ""
const workerPath = process.env["GHOSTPING_WORKER_PATH"] ?? "./target/release/ghostping-worker"
if (!databaseUrl) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const PgLive = PgClient.layer({ url: Redacted.make(databaseUrl) })
const Repos = Layer.mergeAll(CheckRunRepositoryLive, ObservationRepositoryLive, QuestionRepositoryLive)
const WorkerLive = RustObservationWorkerLive(workerPath)
const RunnerLive = CheckRunnerLive.pipe(Layer.provide(WorkerLive), Layer.provide(Repos), Layer.provide(PgLive))

const pollIntervalMs = Number(process.env["WORKER_POLL_MS"] ?? "1000")

const main: Effect.Effect<void> = Effect.gen(function*() {
  const runner = yield* CheckRunner
  while (true) {
    const didWork = yield* runner.runOnce().pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          console.error(JSON.stringify({ level: "error", msg: "runner error", error: String(e).slice(0, 500) }))
          return false as boolean
        }),
      ),
    )
    if (!didWork) yield* Effect.sleep(`${pollIntervalMs} millis`)
  }
}).pipe(Effect.provide(RunnerLive), Effect.scoped) as unknown as Effect.Effect<void>

NodeRuntime.runMain(main)
