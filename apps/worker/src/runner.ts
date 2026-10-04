import { Config, type ConfigError, Effect, Fiber, Layer, Redacted } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
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
  ProviderAttemptEvidenceRepositoryLive,
  ProductReadRepositoryLive,
  QuestionRepositoryLive,
  type RawDigestMismatch,
  type RowDecodeError,
} from "@ghostping/db"
import { CheckRunner, CheckRunnerLive } from "./check-runner.js"
import { DiscoveryRunner, DiscoveryRunnerLive } from "./discovery-runner.js"
import { NineRouterSettingsLive } from "@ghostping/config"
import { MockProviderLive, NineRouterProviderLive, ProviderRegistryLive } from "@ghostping/providers"
import { NodeHttpClient } from "@effect/platform-node"

// Worker configuration comes from the Effect ConfigProvider (process env by
// default). A missing DATABASE_URL surfaces as a ConfigError through runMain
// instead of a hand-rolled check + process.exit.
const WorkerConfig = Config.all({
  databaseUrl: Config.redacted("DATABASE_URL"),
  pollIntervalMs: Config.integer("WORKER_POLL_MS").pipe(Config.withDefault(1000), Config.validate({ message: "poll interval must be 1..60000 milliseconds", validation: n => n > 0 && n <= 60000 })),
})

const buildRunnerLive = (databaseUrl: Redacted.Redacted<string>) => {
  const PgLive = PgClient.layer({ url: databaseUrl })
  const Repos = Layer.mergeAll(
    CheckRunRepositoryLive,
    ObservationRepositoryLive,
    ProviderAttemptEvidenceRepositoryLive,
    QuestionRepositoryLive,
    DiscoveryScopeRepositoryLive,
    DiscoveryRunRepositoryLive,
    DiscoveryFrontierRepositoryLive,
    DiscoveryObservationRepositoryLive,
    DiscoveryMatchRepositoryLive,
    FactRepositoryLive,
    ProductReadRepositoryLive,
  )
  const GatewayLive = NineRouterProviderLive.pipe(Layer.provide(NineRouterSettingsLive), Layer.provide(NodeHttpClient.layer))
  const ProvidersLive = ProviderRegistryLive.pipe(Layer.provide(Layer.merge(MockProviderLive, GatewayLive)))
  const CheckLive = CheckRunnerLive.pipe(Layer.provide(ProvidersLive), Layer.provide(Repos), Layer.provide(PgLive))
  const DiscoveryLive = DiscoveryRunnerLive.pipe(Layer.provide(Repos), Layer.provide(PgLive))
  return Layer.merge(CheckLive, DiscoveryLive)
}

export type RunnerLoopError = SqlError | RowDecodeError | RawDigestMismatch

export interface LoopRunners {
  readonly check: { readonly runOnce: () => Effect.Effect<boolean, RunnerLoopError> }
  readonly discovery: { readonly runOnce: () => Effect.Effect<boolean, RunnerLoopError> }
}

/**
 * Independent bounded worker loops. Each loop owns its queue claim and
 * sleeps only when idle; a multi-minute discovery scan occupies only its
 * own fiber, so CheckRunner keeps polling. Failures are contained per
 * loop (logged through the Effect Logger, bounded) and never terminate the
 * sibling. No Redis/Kafka, no unbounded fibers: exactly two.
 */
export const startRunnerLoops = (runners: LoopRunners, pollMs: number): Effect.Effect<void, never, never> =>
  Effect.gen(function*() {
    const loop = (which: "check" | "discovery", runOnce: () => Effect.Effect<boolean, RunnerLoopError>) => {
      const step: Effect.Effect<void> = Effect.gen(function*() {
        while (true) {
          const did = yield* runOnce().pipe(
            Effect.catchAll((e) =>
              Effect.logError(`${which} runner error`).pipe(
                Effect.annotateLogs({ runner: which, error: e._tag }),
                Effect.as(false),
              ),
            ),
          )
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

const main: Effect.Effect<void, SqlError | ConfigError.ConfigError> = Effect.flatMap(WorkerConfig, (cfg) =>
  Effect.gen(function*() {
    const check = yield* CheckRunner
    const discovery = yield* DiscoveryRunner
    yield* startRunnerLoops({ check, discovery }, cfg.pollIntervalMs)
  }).pipe(
    Effect.provide(buildRunnerLive(cfg.databaseUrl)),
    Effect.scoped,
  ),
)

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
  NodeRuntime.runMain(main)
}
