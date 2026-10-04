import { HttpServer } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { PgClient } from "@effect/sql-pg"
import { createServer } from "node:http"
import {
  AuthRepositoryLive,
  BusinessRepositoryLive,
  CheckRunRepositoryLive,
  ClaimRepositoryLive,
  DiscoveryFrontierRepositoryLive,
  DiscoveryMatchRepositoryLive,
  DiscoveryObservationRepositoryLive,
  DiscoveryRunRepositoryLive,
  DiscoveryScopeRepositoryLive,
  FactRepositoryLive,
  JudgmentRepositoryLive,
  ObservationRepositoryLive,
  ProductReadRepositoryLive,
  QuestionRepositoryLive,
} from "@ghostping/db"
import { makeRouter } from "./router.js"

const Repos = Layer.mergeAll(
  AuthRepositoryLive,
  BusinessRepositoryLive,
  FactRepositoryLive,
  QuestionRepositoryLive,
  CheckRunRepositoryLive,
  ObservationRepositoryLive,
  ClaimRepositoryLive,
  JudgmentRepositoryLive,
  ProductReadRepositoryLive,
  DiscoveryScopeRepositoryLive,
  DiscoveryRunRepositoryLive,
  DiscoveryFrontierRepositoryLive,
  DiscoveryObservationRepositoryLive,
  DiscoveryMatchRepositoryLive,
)

// Only what the API consumes: requiring unused keys (session secret,
// worker path) at boot would be a regression for dev and deploy.
const ApiConfig = Config.all({
  databaseUrl: Config.redacted("DATABASE_URL"),
  port: Config.integer("PORT").pipe(Config.withDefault(3001)),
  appBaseUrl: Config.string("APP_BASE_URL").pipe(Config.withDefault("http://localhost:3000")),
})

const main = Effect.flatMap(ApiConfig, (config) =>
  Effect.gen(function*() {
    yield* Effect.logInfo(`API listening on port ${config.port}`)
    const PgLive = PgClient.layer({ url: config.databaseUrl })
    // Wire Postgres into the repositories (sequential), then serve.
    const ReposProvided = Layer.provideMerge(Repos, PgLive)
    const ServerLive = HttpServer.serve(makeRouter()).pipe(
      Layer.provide(ReposProvided),
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port: config.port })),
    )
    yield* Layer.launch(ServerLive)
  }),
)

NodeRuntime.runMain(main)
