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
  EvidenceLineageRepositoryLive,
  FactRepositoryLive,
  InterventionBindingRepositoryLive,
  InterventionRepositoryLive,
  JudgmentRepositoryLive,
  ObservationRepositoryLive,
  ProductReadRepositoryLive,
  QuestionRepositoryLive,
  SiteFindingEventRepositoryLive,
  SiteFindingRepositoryLive,
  SiteFixProposalRepositoryLive,
  SiteGscRepositoryLive,
  SiteMutationRepositoryLive,
  SiteOperatorEventRepositoryLive,
  SitePageObservationRepositoryLive,
  SiteRunRepositoryLive,
  SiteTargetRepositoryLive,
  SiteVerificationRepositoryLive,
  SourceTargetRepositoryLive,
  ReobservationIntentRepositoryLive,
  ReobservationRepositoryLive,
} from "@ghostping/db"
import { makeRouter } from "./router.js"

const Repos = Layer.mergeAll(
  AuthRepositoryLive,
  BusinessRepositoryLive,
  FactRepositoryLive,
  QuestionRepositoryLive,
  SourceTargetRepositoryLive,
  CheckRunRepositoryLive,
  ObservationRepositoryLive,
  ClaimRepositoryLive,
  InterventionBindingRepositoryLive,
  InterventionRepositoryLive,
  JudgmentRepositoryLive,
  ProductReadRepositoryLive,
  QuestionRepositoryLive,
  SourceTargetRepositoryLive,
  ReobservationIntentRepositoryLive,
  ReobservationRepositoryLive,
  DiscoveryScopeRepositoryLive,
  DiscoveryRunRepositoryLive,
  EvidenceLineageRepositoryLive,
  DiscoveryFrontierRepositoryLive,
  DiscoveryObservationRepositoryLive,
  DiscoveryMatchRepositoryLive,
  SiteTargetRepositoryLive,
  SiteRunRepositoryLive,
  SitePageObservationRepositoryLive,
  SiteFindingRepositoryLive,
  SiteFindingEventRepositoryLive,
  SiteFixProposalRepositoryLive,
  SiteMutationRepositoryLive,
  SiteVerificationRepositoryLive,
  SiteOperatorEventRepositoryLive,
  SiteGscRepositoryLive,
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
