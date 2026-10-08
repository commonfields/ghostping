import { describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer } from "effect"
import { AuthRepository, BusinessRepository, RecordRepository, type RecordSnapshot } from "@openrecord/db"
import { recordApi } from "./record-routes.js"

const token = "A".repeat(43)
const snapshot: RecordSnapshot = {
  profile: { businessId: "TEST-business", name: "TEST client", websiteUrl: "https://client.test/", engagement: "FIXTURE", createdAt: "2026-10-01T00:00:00Z" },
  items: [], runs: [], checks: [], actions: [],
  share: { id: "TEST-share", publicId: token, status: "ACTIVE", createdAt: "2026-10-01T00:00:00Z", revokedAt: null },
}

describe("public record revocation during evidence loading", () => {
  const read = async (loaded: RecordSnapshot, revokedDuringLoad: boolean) => {
    let lookups = 0
    const unused = () => Effect.die("unexpected operator repository call")
    const layer = Layer.succeed(RecordRepository, {
      listClients: unused, createClient: unused, updateClient: unused, saveSlot: unused, approveItem: unused,
      startRun: unused, judge: unused, recordAction: unused, share: unused, revokeShare: unused,
      snapshot: () => Effect.succeed(loaded),
      businessForPublicId: () => Effect.sync(() => ++lookups > 1 && revokedDuringLoad ? null : "TEST-business"),
    })
    const dependencies = Layer.mergeAll(layer,
      Layer.succeed(AuthRepository, { getSession: unused, signup: unused, signinLookup: unused, createSession: unused, deleteSession: unused }),
      Layer.succeed(BusinessRepository, { create: unused, list: unused, getScoped: unused }))
    const web = HttpApp.toWebHandlerLayer(recordApi(() => Effect.die("unexpected operator call")), dependencies)
    try { return await web.handler(new Request(`http://localhost/api/public/records/${token}`)) }
    finally { await web.dispose() }
  }
  it("returns 404 when the snapshot observes revocation", async () => {
    expect((await read({ ...snapshot, share: null }, false)).status).toBe(404)
  })
  it("returns 404 when the token was rotated during loading", async () => {
    expect((await read({ ...snapshot, share: { ...snapshot.share!, publicId: "B".repeat(43) } }, false)).status).toBe(404)
  })
  it("returns 404 when access is revoked after the snapshot", async () => {
    const response = await read(snapshot, true)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ _tag: "RecordNotFound" })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})
