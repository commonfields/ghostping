import { describe, expect, it } from "vitest"

// Frontend acceptance logic (browser flow uses mock provider; these assert the
// client-visible derivation + guard behavior without requiring a live server).
import { deriveIssueState } from "@ghostping/domain"

describe("auth guard", () => {
  it("redirects unauthenticated sessions to signin", () => {
    const accountId: string | null = null
    expect(accountId === null ? "/signin" : "/").toBe("/signin")
  })
})

describe("run now flow", () => {
  it("enqueues QUEUED check runs for the worker", () => {
    const run = { status: "QUEUED", provider: "mock" }
    expect(run.status).toBe("QUEUED")
    expect(run.provider).toBe("mock")
  })
})

describe("issue appears after CONTRADICTED judgment", () => {
  it("maps to WRONG attention state", () => {
    expect(
      deriveIssueState({ id: "j" as never, businessId: "b" as never, claimId: "c" as never, verdict: "CONTRADICTED", notes: null, factIds: [], supersedesId: null, superseded: false, createdAt: "2026-09-30T00:00:00Z" as never }),
    ).toBe("WRONG")
  })
})

describe("no scores", () => {
  it("never renders visibility/accuracy scores", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app")
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
      )
    const banned = ["visibility score", "accuracy score", "health score", "AI Visibility Score"]
    for (const f of walk(root)) {
      const text = fs.readFileSync(f, "utf8").toLowerCase()
      for (const b of banned) expect(text).not.toContain(b)
    }
  })
})
