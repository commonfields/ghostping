import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  BusinessRepository,
  CheckRunRepository,
  ClaimRepository,
  FactRepository,
  JudgmentRepository,
  ObservationRepository,
  QuestionRepository,
} from "./repositories.js"

// In-memory test Layers: prove service wiring without requiring Postgres.
// Pure domain tests never touch PG; integration tests (integration.test.ts)
// cover the real database separately.
const memBusiness = () => {
  const store = new Map<string, { id: string; accountId: string; name: string; createdAt: string }>()
  return Layer.succeed(BusinessRepository, {
    create: (accountId: string, name: string) =>
      Effect.sync(() => {
        const row = { id: `b-${store.size + 1}`, accountId, name, createdAt: new Date().toISOString() }
        store.set(row.id, row)
        return row
      }),
    list: (accountId: string) => Effect.succeed([...store.values()].filter((b) => b.accountId === accountId)),
    getScoped: (accountId: string, id: string) =>
      Effect.succeed([...store.values()].find((b) => b.id === id && b.accountId === accountId) ?? null),
  })
}

describe("repository test Layers", () => {
  it("enforces account scoping in-memory", async () => {
    const prog = Effect.gen(function*() {
      const repo = yield* BusinessRepository
      const created = yield* repo.create("acct-a", "Northstar")
      const cross = yield* repo.getScoped("acct-b", created.id)
      const own = yield* repo.getScoped("acct-a", created.id)
      return { cross, own }
    })
    const { cross, own } = await Effect.runPromise(prog.pipe(Effect.provide(memBusiness())))
    expect(cross).toBeNull()
    expect(own?.name).toBe("Northstar")
  })

  it("exposes all repository tags", () => {
    for (const tag of [BusinessRepository, FactRepository, QuestionRepository, CheckRunRepository, ObservationRepository, ClaimRepository, JudgmentRepository]) {
      expect(tag.key).toMatch(/Repository/)
    }
  })
})
