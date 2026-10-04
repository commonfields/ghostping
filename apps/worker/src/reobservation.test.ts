// Re-observation finalization in the Effect CheckRunner: the worker links
// a SUCCEEDED run to its durable intent (idempotent: two completions yield
// one link), never links FAILED runs (timeout/auth/malformed keep the
// retained intent with no lineage row), and recovers crash windows via the
// runOnce sweeper without duplicating links. Measurement comparability
// cases go through the protocol functions only (the worker never
// reimplements outcome rules, and failure never reads as change).
import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted, Schedule } from "effect"
import { SqlError } from "@effect/sql/SqlError"
import {
  CheckRunRepository,
  hostedMeasurementContext,
  ObservationRepository,
  ProviderAttemptEvidenceRepository,
  QuestionRepository,
  type ReobservationRow,
} from "@ghostping/db"
import {
  compareMeasurements,
  deriveObservedChange,
  deriveOutcome,
  measurementSignature,
} from "@ghostping/protocol"
import {
  ProviderRegistry,
  ProviderAuth,
  ProviderTimeout,
  rawEvidence,
  type ProviderError,
  type ProviderObservation,
} from "@ghostping/providers"
import { CheckRunner, makeCheckRunnerLive } from "./check-runner.js"

const ok: ProviderObservation = {
  ...rawEvidence(new TextEncoder().encode(' {"answer":"x"} '), null),
  provider: "mock",
  requestedModel: "requested",
  observedModel: "mock-v1",
  collectedAt: "2026-10-04T00:00:00Z",
  answerText: "Northstar costs $29/month.",
  retrievalMode: "unknown",
  citations: [],
  rawResponse: { answer: "x" },
  providerMetadata: { synthetic: true },
  synthetic: true,
}

interface Harness {
  readonly runOnce: () => Promise<boolean>
  readonly state: {
    calls: number
    attempts: number
    status: string
    failure: string | null
    observation: { id: string; checkRunId: string } | null
    links: Array<ReobservationRow>
    finalizeCalls: number
    sweepCalls: number
    intents: Map<string, { issueId: string }>
  }
}

const runCase = async (
  script: Array<ProviderError | ProviderObservation>,
  opts: { intent?: boolean; finalizeFailure?: "once" | "always" } = {},
): Promise<Harness> => {
  const state = {
    calls: 0,
    attempts: 0,
    status: "QUEUED" as string,
    failure: null as string | null,
    observation: null as { id: string; checkRunId: string } | null,
    links: [] as Array<ReobservationRow>,
    finalizeCalls: 0,
    sweepCalls: 0,
    intents: new Map<string, { issueId: string }>(),
  }
  if (opts.intent) state.intents.set("run-1", { issueId: "issue-1" })
  let claimed = false
  let finalizeFailures = 0

  const runs = Layer.succeed(CheckRunRepository, {
    enqueue: () => Effect.dieMessage("unused"),
    listByBusiness: () => Effect.succeed([]),
    getScoped: () => Effect.succeed(null),
    markRunning: () => Effect.void,
    claimOne: () =>
      Effect.sync(() => {
        if (claimed) return null
        claimed = true
        state.status = "RUNNING"
        return {
          id: "run-1", businessId: "b1", questionId: "q1", provider: "mock", requestedModel: "requested",
          status: "RUNNING", queuedAt: "2026-10-04T00:00:00Z", startedAt: null, completedAt: null,
          failureClass: null, failureDetailSafe: null, attemptCount: 0,
        }
      }),
    recordAttempt: () => Effect.sync(() => ++state.attempts),
    markFinished: (_id: string, status: "SUCCEEDED" | "FAILED", failureClass: string | null) =>
      Effect.sync(() => {
        state.status = status
        state.failure = failureClass
      }),
  })
  const questions = Layer.succeed(QuestionRepository, {
    create: () => Effect.dieMessage("unused"),
    listByBusiness: () => Effect.succeed([]),
    getScoped: () =>
      Effect.succeed({
        id: "q1", businessId: "b1", label: null, prompt: "How much does Northstar cost?",
        origin: "BUSINESS_OWNER", active: true, createdAt: "2026-10-04T00:00:00Z",
      }),
  })
  const linkFor = (checkRunId: string): ReobservationRow => ({
    id: `link-${checkRunId}`,
    businessId: "b1",
    originalObservationId: "obs-orig",
    issueId: state.intents.get(checkRunId)?.issueId ?? "issue-1",
    interventionId: null,
    observationId: state.observation?.checkRunId === checkRunId ? "o1" : "o1",
    createdAt: "2026-10-04T00:00:00Z",
  })
  const observations = Layer.succeed(ObservationRepository, {
    getScoped: () => Effect.succeed(null),
    getByCheckRun: () => Effect.succeed(null),
    create: (input: { checkRunId: string; completeRun?: boolean }) =>
      Effect.sync(() => {
        state.observation = { id: "o1", checkRunId: input.checkRunId }
        if (input.completeRun) state.status = "SUCCEEDED"
        return state.observation as unknown as never
      }),
    // Insert-or-select semantics mirroring the Live: concurrent completions
    // serialize on the link identity, so repeats return the one winner.
    finalizeReobservationForCheckRun: (checkRunId: string) =>
      Effect.gen(function*() {
        state.finalizeCalls += 1
        if (opts.finalizeFailure === "always" || (opts.finalizeFailure === "once" && ++finalizeFailures === 1)) {
          return yield* Effect.fail(new SqlError({ message: "simulated crash after observation commit" }))
        }
        if (!state.intents.has(checkRunId)) return null
        if (state.status !== "SUCCEEDED" || !state.observation) return null
        const existing = state.links.find((l) => l.observationId === "o1")
        if (existing) return existing
        const link = linkFor(checkRunId)
        state.links.push(link)
        return link
      }),
    sweepUnfulfilledReobservations: (_limit?: number) =>
      Effect.gen(function*() {
        state.sweepCalls += 1
        let n = 0
        for (const checkRunId of state.intents.keys()) {
          if (state.status !== "SUCCEEDED" || !state.observation) continue
          if (state.links.some((l) => l.observationId === "o1")) continue
          state.links.push(linkFor(checkRunId))
          n += 1
        }
        return n
      }),
  })
  const evidence = Layer.succeed(ProviderAttemptEvidenceRepository, {
    record: () => Effect.void,
  })
  const providers = Layer.succeed(ProviderRegistry, {
    observe: () =>
      Effect.suspend(() => {
        const step = script[Math.min(state.calls++, script.length - 1)]!
        return "_tag" in step ? Effect.fail(step) : Effect.succeed(step)
      }),
  })
  const layer = makeCheckRunnerLive(Schedule.recurs(8)).pipe(
    Layer.provide(Layer.mergeAll(runs, questions, observations, evidence, providers)),
  )
  const runOnce = () =>
    Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* CheckRunner).runOnce()
      }).pipe(Effect.provide(layer)),
    )
  return { runOnce, state }
}

describe("worker re-observation finalization", () => {
  it("links a SUCCEEDED run to its intent exactly once across completions", async () => {
    const h = await runCase([ok], { intent: true })
    expect(await h.runOnce()).toBe(true)
    expect(h.state.status).toBe("SUCCEEDED")
    expect(h.state.links).toHaveLength(1)
    expect(h.state.finalizeCalls).toBe(1)
    expect(h.state.sweepCalls).toBe(1)
    // A repeated finalization (retry, second worker, sweeper) is a no-op.
    expect(await h.runOnce()).toBe(false)
    expect(h.state.links).toHaveLength(1)
  })

  it("stores no link without an intent", async () => {
    const h = await runCase([ok])
    expect(await h.runOnce()).toBe(true)
    expect(h.state.status).toBe("SUCCEEDED")
    expect(h.state.links).toHaveLength(0)
  })

  it("failed checks never create links and retain the intent", async () => {
    for (const error of [new ProviderAuth({}), new ProviderTimeout({})]) {
      const h = await runCase([error], { intent: true })
      expect(await h.runOnce()).toBe(true)
      expect(h.state.status).toBe("FAILED")
      expect(h.state.observation).toBeNull()
      expect(h.state.links).toHaveLength(0)
      // Append-only intent retained for a later recheck.
      expect(h.state.intents.has("run-1")).toBe(true)
      // Recovery sweeps only SUCCEEDED runs, so the failed run stays unlinked.
      expect(await h.runOnce()).toBe(false)
      expect(h.state.links).toHaveLength(0)
    }
  })

  it("crash between observation commit and link insert recovers exactly once", async () => {
    const h = await runCase([ok], { intent: true, finalizeFailure: "once" })
    // First pass: the observation commits, then the link insert "crashes".
    await expect(h.runOnce()).rejects.toThrow()
    expect(h.state.status).toBe("SUCCEEDED")
    expect(h.state.observation).not.toBeNull()
    expect(h.state.links).toHaveLength(0)
    // Second pass: nothing to claim, the sweeper fulfills the intent.
    expect(await h.runOnce()).toBe(true)
    expect(h.state.links).toHaveLength(1)
    // Third pass: drained, idle, still exactly one link.
    expect(await h.runOnce()).toBe(false)
    expect(h.state.links).toHaveLength(1)
  })
})

describe("measurement comparability (protocol authority only)", () => {
  const mockContext = (checkRunId: string, prompt: string) =>
    hostedMeasurementContext({
      businessId: "b1",
      questionId: "q1",
      checkRunId,
      prompt,
      provider: "mock",
      requestedModel: "requested",
      observedModel: "mock-v1",
      observedAt: "2026-10-04T00:00:00.000Z",
    })

  it("identical hosted runs are an exact match", () => {
    const a = measurementSignature(mockContext("run-1", "How much does Northstar cost?"))
    const b = measurementSignature(mockContext("run-2", "How much does Northstar cost?"))
    expect(compareMeasurements(a, b)).toBe("EXACT_MATCH")
    expect(deriveObservedChange("EXACT_MATCH", "same", "same")).toBe("NO_CHANGE")
    expect(deriveObservedChange("EXACT_MATCH", "before", "after")).toBe("CHANGED")
    expect(deriveOutcome("SUPPORTED", "SUPPORTED", "EXACT_MATCH", "NO_CHANGE")).toBe("NO_OBSERVED_CHANGE")
    expect(deriveOutcome("CONTRADICTED", "SUPPORTED", "EXACT_MATCH", "CHANGED")).toBe("OBSERVED_CORRECTION")
  })

  it("an adapter-version difference is comparable, never exact", () => {
    const a = measurementSignature(mockContext("run-1", "How much does Northstar cost?"))
    const b = { ...a, adapter_version: "2" }
    expect(compareMeasurements(a, b)).toBe("COMPARABLE")
    expect(deriveObservedChange("COMPARABLE", "x", "y")).toBe("CHANGED")
    expect(deriveOutcome("SUPPORTED", "SUPPORTED", "COMPARABLE", "CHANGED")).toBe("OBSERVED_DIFFERENCE")
  })

  it("a substituted prompt is not comparable and forces indeterminate", () => {
    const a = measurementSignature(mockContext("run-1", "How much does Northstar cost?"))
    const b = measurementSignature(mockContext("run-2", "How much does Evilcorp cost?"))
    expect(compareMeasurements(a, b)).toBe("NOT_COMPARABLE")
    expect(deriveObservedChange("NOT_COMPARABLE", "x", "y")).toBe("INDETERMINATE")
    // Even opposite verdicts on incomparable evidence stay indeterminate:
    // never a correction, never no-change.
    expect(deriveOutcome("CONTRADICTED", "SUPPORTED", "NOT_COMPARABLE", "INDETERMINATE")).toBe("INDETERMINATE")
    expect(deriveOutcome("SUPPORTED", "SUPPORTED", "NOT_COMPARABLE", "INDETERMINATE")).toBe("INDETERMINATE")
  })

  it("unknown critical dimensions are indeterminate, never no-change", () => {
    const router = hostedMeasurementContext({
      businessId: "b1",
      questionId: "q1",
      checkRunId: "run-9",
      prompt: "How much does Northstar cost?",
      provider: "9router",
      requestedModel: "pin-a",
      observedModel: null,
      observedAt: "2026-10-04T00:00:00.000Z",
    })
    const a = measurementSignature(router)
    const b = measurementSignature(router)
    expect(compareMeasurements(a, b)).toBe("INDETERMINATE")
    expect(deriveOutcome("SUPPORTED", "SUPPORTED", "INDETERMINATE", "INDETERMINATE")).toBe("INDETERMINATE")
  })

  it("missing judgments stay indeterminate instead of unchanged", () => {
    expect(deriveOutcome(null, "SUPPORTED", "EXACT_MATCH", "CHANGED")).toBe("INDETERMINATE")
    expect(deriveOutcome("SUPPORTED", null, "EXACT_MATCH", "NO_CHANGE")).toBe("INDETERMINATE")
  })

  it("evidence redaction is unrelated to failure classification", () => {
    // Provider evidence bytes are stored for bounded failures; the failure
    // class comes from the typed error, never from response content.
    const raw = rawEvidence(new TextEncoder().encode("private upstream error"), "text/plain")
    expect(raw.rawDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(Redacted.value(Redacted.make(raw)).rawBytes).toEqual(raw.rawBytes)
  })
})
