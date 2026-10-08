import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted, Schedule } from "effect"
import { SqlError } from "@effect/sql/SqlError"
import { CheckRunRepository, ObservationRepository, ProviderAttemptEvidenceRepository, QuestionRepository } from "@openrecord/db"
import { ProviderRegistry, ProviderAuth, ProviderRateLimited, ProviderTimeout, ProviderUnavailable, ProviderMalformed, ProviderUnsupported, ProviderContractMismatch, rawEvidence, type ProviderError, type ProviderObservation } from "@openrecord/providers"
import { CheckRunner, makeCheckRunnerLive, MAX_PROVIDER_ATTEMPTS } from "./check-runner.js"
const ok: ProviderObservation = {
  ...rawEvidence(new TextEncoder().encode(' {"answer":"x"} '), null), provider: "mock", requestedModel: "requested", observedModel: "mock-v1",
  collectedAt: "2026-10-04T00:00:00Z", answerText: "Northstar costs $29/month.", retrievalMode: "unknown", citations: [],
  rawResponse: { answer: "x" }, providerMetadata: { synthetic: true }, synthetic: true,
}
const runCase = async (script: Array<ProviderError | ProviderObservation>, opts: { grouped?: boolean; missing?: boolean; attemptFailure?: boolean; evidenceFailure?: boolean } = {}) => {
  const state = { calls: 0, attempts: 0, status: "RUNNING", failure: null as string | null, observation: null as unknown, evidence: [] as unknown[] }
  const runs = Layer.succeed(CheckRunRepository, {
    enqueue: () => Effect.dieMessage("unused"), listByBusiness: () => Effect.succeed([]), getScoped: () => Effect.succeed(null), markRunning: () => Effect.void,
    claimOne: () => Effect.succeed({ ...(opts.grouped ? { assaySampleGroupId: "group-1" } : {}), id: "run-1", businessId: "b1", questionId: "q1", provider: "mock", requestedModel: "requested", status: "RUNNING", queuedAt: "2026-10-04T00:00:00Z", startedAt: null, completedAt: null, failureClass: null, failureDetailSafe: null, attemptCount: 0 }),
    recordAttempt: () => opts.attemptFailure ? Effect.fail(new SqlError({ message: "test failure" })) : Effect.sync(() => ++state.attempts),
    recoverAbandoned: () => Effect.succeed(0),
    markFinished: (_id, status, failureClass) => Effect.sync(() => { state.status = status; state.failure = failureClass }),
  })
  const questions = Layer.succeed(QuestionRepository, {
    create: () => Effect.dieMessage("unused"), listByBusiness: () => Effect.succeed([]),
    getScoped: () => Effect.succeed(opts.missing ? null : { id: "q1", businessId: "b1", label: null, prompt: "How much does Northstar cost?", origin: "BUSINESS_OWNER", active: true, createdAt: "2026-10-04T00:00:00Z" }),
  })
  const observations = Layer.succeed(ObservationRepository, {
    getScoped: () => Effect.succeed(null), getByCheckRun: () => Effect.succeed(null),
    finalizeReobservationForCheckRun: () => Effect.succeed(null),
    sweepUnfulfilledReobservations: () => Effect.succeed(0),
    create: input => Effect.sync(() => {
      state.observation = input
      if (input.completeRun) state.status = "SUCCEEDED"
      return { id: "o1", businessId: input.businessId, checkRunId: input.checkRunId, provider: input.provider, requestedModel: input.requestedModel, observedModel: input.observedModel, collectedAt: input.collectedAt, answerText: input.answerText, retrievalMode: input.retrievalMode, rawEvidenceId: "raw1", rawDigest: input.rawDigest, surfaceIdentity: input.surfaceIdentity, measurementContext: input.measurementContext, synthetic: input.synthetic ?? false, citations: input.citations }
    }),
  })
  const evidence = Layer.succeed(ProviderAttemptEvidenceRepository, {
    record: input => opts.evidenceFailure ? Effect.fail(new SqlError({ message: "test evidence failure" })) : Effect.sync(() => { state.evidence.push(input) }),
  })
  const providers = Layer.succeed(ProviderRegistry, { observe: () => Effect.suspend(() => {
    const step = script[Math.min(state.calls++, script.length - 1)]!
    return "_tag" in step ? Effect.fail(step) : Effect.succeed(step)
  }) })
  const result = await Effect.runPromise(Effect.gen(function*() { return yield* (yield* CheckRunner).runOnce() }).pipe(
    Effect.provide(makeCheckRunnerLive(Schedule.recurs(8)).pipe(Layer.provide(Layer.mergeAll(runs, questions, observations, evidence, providers)))), Effect.either,
  ))
  return { ...state, result }
}
describe("Effect CheckRunner", () => {
  it("persists exact bytes, model identity, synthetic semantics, and protocol context", async () => {
    const out = await runCase([ok])
    expect(out.status).toBe("SUCCEEDED")
    expect(out.attempts).toBe(1)
    expect(out.observation).toMatchObject({ rawBytesHex: Buffer.from(ok.rawBytes).toString("hex"), rawContentType: null,
      rawDigest: ok.rawDigest, requestedModel: "requested", observedModel: "mock-v1", synthetic: true, completeRun: true,
      measurementContext: { business_id: "b1", question_id: "q1", question: "How much does Northstar cost?" } })
  })
  it.each([new ProviderRateLimited({}), new ProviderTimeout({}), new ProviderUnavailable({})])("retries $._tag then succeeds", async error => {
    const out = await runCase([error, ok])
    expect(out.status).toBe("SUCCEEDED")
    expect(out.attempts).toBe(2)
  })
  it.each([new ProviderAuth({}), new ProviderMalformed({}), new ProviderUnsupported({}), new ProviderContractMismatch({})])("does not retry $._tag", async error => {
    const out = await runCase([error, ok])
    expect(out.status).toBe("FAILED")
    expect(out.attempts).toBe(1)
    expect(out.observation).toBeNull()
  })
  it("enforces four actual calls even with a broader supplied Schedule", async () => {
    const out = await runCase([new ProviderUnavailable({})])
    expect(out.calls).toBe(MAX_PROVIDER_ATTEMPTS)
    expect(out.attempts).toBe(MAX_PROVIDER_ATTEMPTS)
    expect(out.failure).toBe("PROVIDER_UNAVAILABLE")
  })
  it("stores each bounded failure body before retry without creating an observation", async () => {
    const raw = rawEvidence(new TextEncoder().encode("private upstream error"), "text/plain")
    const out = await runCase([new ProviderAuth({ evidence: Redacted.make(raw), status: 401 })])
    expect(out.evidence).toHaveLength(1)
    expect(out.evidence[0]).toMatchObject({ bytes: raw.rawBytes, digest: raw.rawDigest, failureClass: "PROVIDER_AUTH", attempt: 1 })
    expect(out.observation).toBeNull()
  })
  it("assay execution without its repository fails before any provider call", async () => {
    const out = await runCase([ok], { grouped: true })
    expect(out.calls).toBe(0)
    expect(out.status).toBe("FAILED")
    expect(out.failure).toBe("PROVIDER_UNSUPPORTED")
  })
  it("missing question fails without invoking a provider", async () => {
    const out = await runCase([ok], { missing: true })
    expect(out.calls).toBe(0)
    expect(out.attempts).toBe(0)
    expect(out.status).toBe("FAILED")
  })
  it("database failure cannot be retried as provider failure or reported as success", async () => {
    for (const opts of [{ attemptFailure: true }, { evidenceFailure: true }]) {
      const out = await runCase([new ProviderUnavailable({ evidence: Redacted.make(rawEvidence(new Uint8Array([1]), null)) })], opts)
      expect(out.result._tag).toBe("Left")
      expect(out.calls).toBeLessThanOrEqual(1)
      expect(out.status).toBe("RUNNING")
    }
  })
})
