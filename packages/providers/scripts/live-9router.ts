// Explicit operator-only contract probe. No database, retries, or body output.
import { Config, Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { NineRouterSettingsLive } from "@ghostping/config"
import { NineRouterProvider, NineRouterProviderLive, sha256 } from "../src/index.js"
const main = Effect.gen(function*() {
  const enabled = yield* Config.boolean("GHOSTPING_LIVE_PROVIDER").pipe(Config.withDefault(false))
  if (!enabled) return yield* Effect.fail("set GHOSTPING_LIVE_PROVIDER=true to authorize one provider request")
  const prompt = yield* Config.string("PROVIDER_LIVE_PROMPT").pipe(Config.withDefault("Reply with the word ready."))
  const provider = yield* NineRouterProvider
  const result = yield* provider.observe({ runId: "live-contract-probe", provider: "9router", requestedModel: null, prompt })
  if (sha256(result.rawBytes) !== result.rawDigest) return yield* Effect.fail("digest mismatch")
  yield* Effect.logInfo("provider contract passed").pipe(Effect.annotateLogs({ provider: result.provider, requested_model: result.requestedModel,
    observed_model: result.observedModel, citations: result.citations.length, bytes: result.rawBytes.length }))
}).pipe(Effect.provide(NineRouterProviderLive.pipe(Layer.provide(NineRouterSettingsLive), Layer.provide(NodeHttpClient.layer))))
// Curated failure rendering avoids printing config/transport internals.
NodeRuntime.runMain(main.pipe(Effect.catchAll(() => Effect.logError("provider contract probe failed; verify opt-in and provider configuration").pipe(Effect.zipRight(Effect.sync(() => { process.exitCode = 1 }))))))
