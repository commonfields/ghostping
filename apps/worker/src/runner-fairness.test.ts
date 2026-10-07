// Worker fairness: a blocked discovery loop must not starve CheckRunner
// and vice versa. Uses controlled Deferred-blocking stubs (no minutes of
// sleeping, no Postgres) against the real startRunnerLoops composition.
import { Deferred, Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import { RawDigestMismatch } from "@openrecord/db"
import { startRunnerLoops } from "./runner.js"

const testPollMs = 5

const blockingStub = (gate: Deferred.Deferred<void>, counter: { n: number }) => ({
  runOnce: () =>
    Effect.gen(function*() {
      counter.n += 1
      yield* Deferred.await(gate)
      // Idle after release: the loop sleeps, yielding the event loop.
      return false
    }),
})

describe("worker fairness", () => {
  it("CheckRunner progresses while discovery is blocked", async () => {
    // Pre-completed gate lets the check stub iterate; the discovery gate
    // stays closed until released.
    const openProgram = Effect.gen(function*() {
      const open = yield* Deferred.make<void>()
      yield* Deferred.succeed(open, undefined)
      const blocked = yield* Deferred.make<void>()
      const checks = { n: 0 }
      const discoveries = { n: 0 }
      const fiber = yield* Effect.forkScoped(
        startRunnerLoops({ check: blockingStub(open, checks), discovery: blockingStub(blocked, discoveries) }, testPollMs),
      )
      yield* Effect.sleep("80 millis")
      // While discovery is still blocked, checks must have iterated many times.
      expect(checks.n).toBeGreaterThan(2)
      expect(discoveries.n).toBe(1)
      yield* Deferred.succeed(blocked, undefined)
      yield* Effect.sleep("30 millis")
      expect(discoveries.n).toBeGreaterThan(1)
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.scoped)
    await Effect.runPromise(openProgram)
  })

  it("discovery progresses while CheckRunner is blocked", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const open = yield* Deferred.make<void>()
        yield* Deferred.succeed(open, undefined)
        const blocked = yield* Deferred.make<void>()
        const checks = { n: 0 }
        const discoveries = { n: 0 }
        const fiber = yield* Effect.forkScoped(
          startRunnerLoops({ check: blockingStub(blocked, checks), discovery: blockingStub(open, discoveries) }, testPollMs),
        )
        yield* Effect.sleep("80 millis")
        expect(discoveries.n).toBeGreaterThan(2)
        expect(checks.n).toBe(1)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.scoped),
    )
  })

  it("shutdown interrupts both owned loops and runs their finalizers", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      let active = 0
      let finalized = 0
      const owned = { runOnce: () => Effect.gen(function*() {
        active++
        if (active === 2) yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      }).pipe(Effect.ensuring(Effect.sync(() => { finalized++ }))) }
      const parent = yield* Effect.forkScoped(startRunnerLoops({ check: owned, discovery: owned }, testPollMs))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(parent)
      expect(finalized).toBe(2)
    }).pipe(Effect.scoped))
  })

  it("a failing loop neither crashes nor starves its sibling", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const checks = { n: 0 }
        const flaky = {
          runOnce: () =>
            Effect.gen(function*() {
              checks.n += 1
              if (checks.n < 3) return yield* Effect.fail(new RawDigestMismatch({ digest: "fixture" }))
              return false
            }),
        }
        const steady = { n: 0 }
        const open = yield* Deferred.make<void>()
        yield* Deferred.succeed(open, undefined)
        const fiber = yield* Effect.forkScoped(
          startRunnerLoops(
            { check: flaky, discovery: { runOnce: () => Effect.gen(function*() { steady.n += 1; return false }) } },
            testPollMs,
          ),
        )
        void open
        yield* Effect.sleep("60 millis")
        // Flaky loop survived its own failures and kept iterating; the
        // sibling iterated independently the whole time.
        expect(checks.n).toBeGreaterThan(3)
        expect(steady.n).toBeGreaterThan(2)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.scoped),
    )
  })
})

describe("assay loop ownership", () => {
  it("a blocked source fetch allows the check loop to progress", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const progressed = yield* Deferred.make<void>()
      let checks = 0
      let assays = 0
      const parent = yield* Effect.forkScoped(startRunnerLoops({
        check: { runOnce: () => Effect.gen(function*() { checks++; if (checks === 3) yield* Deferred.succeed(progressed, undefined); return false }) },
        discovery: { runOnce: () => Effect.succeed(false) },
        assay: { runOnce: () => Effect.gen(function*() { assays++; return yield* Effect.never }) },
      }, testPollMs))
      yield* Deferred.await(progressed)
      expect(assays).toBe(1)
      yield* Fiber.interrupt(parent)
    }).pipe(Effect.scoped))
  })
  it("shutdown cleans up all four loops", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      let active = 0
      let finalized = 0
      const owned = { runOnce: () => Effect.gen(function*() {
        active++; if (active === 4) yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      }).pipe(Effect.ensuring(Effect.sync(() => { finalized++ }))) }
      const parent = yield* Effect.forkScoped(startRunnerLoops({ check: owned, discovery: owned, site: owned, assay: owned }, testPollMs))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(parent)
      expect(finalized).toBe(4)
    }).pipe(Effect.scoped))
  })
})
