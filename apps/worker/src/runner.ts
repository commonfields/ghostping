import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { NodeRuntime } from "@effect/platform-node"
import {
  CheckRunRepositoryLive,
  DiscoveryFrontierRepositoryLive,
  DiscoveryObservationRepositoryLive,
  DiscoveryRunRepositoryLive,
  DiscoveryScopeRepositoryLive,
  FactRepositoryLive,
  ObservationRepositoryLive,
  ProductReadRepositoryLive,
  QuestionRepositoryLive,
} from "@ghostping/db"
import { CheckRunner, CheckRunnerLive } from "./check-runner.js"
import { DiscoveryRunner, DiscoveryRunnerLive } from "./discovery-runner.js"
import { RustObservationWorkerLive } from "./rust-worker.js"

const databaseUrl = process.env["DATABASE_URL"] ?? ""
const workerPath = process.env["GHOSTPING_WORKER_PATH"] ?? "./target/release/ghostping-worker"
if (!databaseUrl) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const PgLive = PgClient.layer({ url: Redacted.make(databaseUrl) })
const Repos = Layer.mergeAll(
  CheckRunRepositoryLive,
  ObservationRepositoryLive,
  QuestionRepositoryLive,
  DiscoveryScopeRepositoryLive,
  DiscoveryRunRepositoryLive,
  DiscoveryFrontierRepositoryLive,
  DiscoveryObservationRepositoryLive,
  FactRepositoryLive,
  ProductReadRepositoryLive,
)
const WorkerLive = RustObservationWorkerLive(workerPath)
const CheckLive = CheckRunnerLive.pipe(Layer.provide(WorkerLive), Layer.provide(Repos), Layer.provide(PgLive))
const DiscoveryLive = DiscoveryRunnerLive.pipe(Layer.provide(Repos), Layer.provide(PgLive))
const RunnerLive = Layer.merge(CheckLive, DiscoveryLive)

const pollIntervalMs = Number(process.env["WORKER_POLL_MS"] ?? "1000")

const quietOnce = (which: "check" | "discovery", e: unknown) =>
  Effect.sync(() => {
    console.error(JSON.stringify({ level: "error", msg: `${which} runner error`, error: String(e).slice(0, 500) }))
    return false as boolean
  })

const main: Effect.Effect<void> = Effect.gen(function*() {
  const check = yield* CheckRunner
  const discovery = yield* DiscoveryRunner
  while (true) {
    // Interleaved, bounded: one claim attempt per runner per tick, sequential
    // (no unbounded fanout, no Redis). Each runner owns its queue claim.
    const didCheck = yield* check.runOnce().pipe(Effect.catchAll((e) => quietOnce("check", e)))
    const didDiscovery = yield* discovery.runOnce().pipe(Effect.catchAll((e) => quietOnce("discovery", e)))
    if (!didCheck && !didDiscovery) yield* Effect.sleep(`${pollIntervalMs} millis`)
  }
}).pipe(Effect.provide(RunnerLive), Effect.scoped) as unknown as Effect.Effect<void>

NodeRuntime.runMain(main)
