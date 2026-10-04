import { HttpServer } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { createServer } from "node:http"
import pg from "pg"
import {
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

const databaseUrl = process.env["DATABASE_URL"] ?? ""
const port = Number(process.env["PORT"] ?? "3001")
if (!databaseUrl) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: databaseUrl })
const PgLive = PgClient.layer({ url: Redacted.make(databaseUrl) })
const Repos = Layer.mergeAll(
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
// Wire Postgres into the repositories (sequential), then serve.
const ReposProvided = Layer.provideMerge(Repos, PgLive)

const router = makeRouter(pool)

const ServerLive = HttpServer.serve(router).pipe(
  Layer.provide(ReposProvided),
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
)

NodeRuntime.runMain(Layer.launch(ServerLive).pipe(Effect.orDie))
