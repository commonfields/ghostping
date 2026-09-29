import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { isRetryableWorkerFailure, RustObservationWorker, RustObservationWorkerLive, sha256Hex } from "./rust-worker.js"

// Uses the real ghostping-worker binary when built; otherwise asserts the
// pure contract helpers. CI builds the binary first (mock only, no network).
const BIN = process.env["GHOSTPING_WORKER_PATH"] ?? "../../target/debug/ghostping-worker"

describe("RustObservationWorker", () => {
  it("computes deterministic digests", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"))
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"))
  })

  it("classifies retryable failures", () => {
    expect(isRetryableWorkerFailure("PROVIDER_RATE_LIMITED")).toBe(true)
    expect(isRetryableWorkerFailure("timeout")).toBe(true)
    expect(isRetryableWorkerFailure("WORKER_CONTRACT_MISMATCH")).toBe(false)
    expect(isRetryableWorkerFailure("malformed response")).toBe(false)
    expect(isRetryableWorkerFailure(null)).toBe(false)
  })

  it("invokes the real binary for mock success", async () => {
    const { existsSync } = await import("node:fs")
    if (!existsSync(BIN)) return
    const layer = RustObservationWorkerLive(BIN, 15_000)
    const prog = Effect.gen(function*() {
      const w = yield* RustObservationWorker
      return yield* w.invoke({ runId: "RUN-TEST-1", provider: "mock", model: null, prompt: "How much does Northstar cost?" })
    })
    const res = await Effect.runPromise(prog.pipe(Effect.provide(layer)))
    expect(res.run_id).toBe("RUN-TEST-1")
    expect(res.contract_version).toBe("ghostping-worker-result-v1")
    expect(res.status).toBe("succeeded")
    expect(res.answer_text).toContain("$29")
    expect(res.retrieval_mode).toBe("unknown")
  })

  it("rejects run_id mismatch", async () => {
    // Point at a shim that returns the wrong run_id.
    const { writeFileSync, chmodSync } = await import("node:fs")
    const shim = "/tmp/gp-worker-wrong-id.sh"
    writeFileSync(
      shim,
      `#!/bin/sh\ncat >/dev/null\necho '{"contract_version":"ghostping-worker-result-v1","run_id":"OTHER","status":"succeeded","provider":"mock","requested_model":null,"observed_model":"mock-v1","collected_at":"2026-09-30T00:00:00Z","answer_text":"x","retrieval_mode":"unknown","citations":[],"raw_digest":"d","raw_response":{},"failure_class":null,"failure_detail_safe":null}'\n`,
    )
    chmodSync(shim, 0o755)
    const layer = RustObservationWorkerLive(shim, 10_000)
    const prog = Effect.gen(function*() {
      const w = yield* RustObservationWorker
      return yield* w.invoke({ runId: "RUN-OK", provider: "mock", model: null, prompt: "hi" })
    })
    const exit = await Effect.runPromise(Effect.exit(prog.pipe(Effect.provide(layer))))
    expect(exit._tag).toBe("Failure")
  })
})
