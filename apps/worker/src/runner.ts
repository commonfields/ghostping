import { Effect, Fiber, Layer, Redacted } from "effect"
import { pathToFileURL } from "node:url"
import { PgClient } from "@effect/sql-pg"
import { NodeRuntime } from "@effect/platform-node"
import {
  CheckRunRepositoryLive,
  DiscoveryFrontierRepositoryLive,
  DiscoveryMatchRepositoryLive,
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

const buildRunnerLive = (databaseUrl: string, workerPath: string) => {
  const PgLive = PgClient.layer({ url: Redacted.make(databaseUrl) })
  const Repos = Layer.mergeAll(
    CheckRunRepositoryLive,
    ObservationRepositoryLive,
    QuestionRepositoryLive,
    DiscoveryScopeRepositoryLive,
    DiscoveryRunRepositoryLive,
    DiscoveryFrontierRepositoryLive,
    DiscoveryObservationRepositoryLive,
    DiscoveryMatchRepositoryLive,
    FactRepositoryLive,
    ProductReadRepositoryLive,
  )
  const WorkerLive = RustObservationWorkerLive(workerPath)
  const CheckLive = CheckRunnerLive.pipe(Layer.provide(WorkerLive), Layer.provide(Repos), Layer.provide(PgLive))
  const DiscoveryLive = DiscoveryRunnerLive.pipe(Layer.provide(Repos), Layer.provide(PgLive))
  return Layer.merge(CheckLive, DiscoveryLive)
}

export interface LoopRunners {
  readonly check: { readonly runOnce: () => Effect.Effect<boolean, unknown> }
  readonly discovery: { readonly runOnce: () => Effect.Effect<boolean, unknown> }
}

/**
 * Independent bounded worker loops. Each loop owns its queue claim and
 * sleeps only when idle; a multi-minute discovery scan occupies only its
 * own fiber, so CheckRunner keeps polling. Failures are contained per
 * loop (logged, bounded) and never terminate the sibling. No Redis/Kafka,
 * no unbounded fibers: exactly two.
 */
export const startRunnerLoops = (runners: LoopRunners, pollMs: number): Effect.Effect<void, never, never> =>
  Effect.gen(function*() {
    const loop = (which: "check" | "discovery", runOnce: () => Effect.Effect<boolean, unknown>) => {
      const step: Effect.Effect<void> = Effect.gen(function*() {
        while (true) {
          const did = (yield* runOnce().pipe(
            Effect.catchAll((e) =>
              Effect.sync(() => {
                console.error(JSON.stringify({ level: "error", msg: `${which} runner error`, error: String(e).slice(0, 500) }))
                return false as boolean
              }),
            ),
          )) as boolean
          if (!did) yield* Effect.sleep(`${pollMs} millis`)
        }
      })
      return step
    }
    // Structured concurrency: both fibers are children of the enclosing
    // fiber/scope, so shutdown interrupts and cleans up both (no detached
    // loops). Neither fiber can fail (errors are caught per iteration), so
    // neither join masks the other.
    const checkFiber = yield* Effect.fork(loop("check", runners.check.runOnce))
    const discoveryFiber = yield* Effect.fork(loop("discovery", runners.discovery.runOnce))
    yield* Fiber.join(checkFiber)
    yield* Fiber.join(discoveryFiber)
  })

const databaseUrl = process.env["DATABASE_URL"] ?? ""
const workerPath = process.env["GHOSTPING_WORKER_PATH"] ?? "./target/release/ghostping-worker"
const pollIntervalMs = Number(process.env["WORKER_POLL_MS"] ?? "1000")

const main: Effect.Effect<void> = Effect.gen(function*() {
  const check = yield* CheckRunner
  const discovery = yield* DiscoveryRunner
  yield* startRunnerLoops({ check, discovery }, pollIntervalMs)
}).pipe(
  Effect.provide(buildRunnerLive(databaseUrl, workerPath)),
  Effect.scoped,
) as unknown as Effect.Effect<void>

// Side-effect free on import (tests import startRunnerLoops): the live
// worker boots only when this module is the entrypoint.
const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  } catch {
    return false
  }
})()
if (isDirectRun) {
  if (!databaseUrl) {
    console.error("DATABASE_URL is required")
    process.exit(1)
  }
  NodeRuntime.runMain(main)
}
