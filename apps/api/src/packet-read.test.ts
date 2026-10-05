// Packet surfacing read model: the route contract asserted DB-free. A stubbed
// lineage covers tenancy, sealing (digest + signatures[] + lineage arrays),
// determinism for a pinned generatedAt, and the router wiring, without a
// Postgres instance.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { knownValue, PROTOCOL_VERSION, schemaId, serializePacket, surfaceForWorker } from "@ghostping/protocol"
import { EvidenceLineageRepository, type IssueLineage } from "@ghostping/db"
import { loadIssuePacket } from "./packet-read.js"

const BIZ = "11111111-1111-4111-8111-111111111111"
const QUESTION = "22222222-2222-4222-8222-222222222222"
const RUN = "33333333-3333-4333-8333-333333333333"
const OBS = "55555555-5555-4555-8555-555555555555"
const CLAIM = "77777777-7777-4777-8777-777777777777"
const JUDGMENT = "j1111111-1111-4111-8111-111111111111"
const PROMPT = "What is the starter price?"
const TEXT = "Starter is $29 per month"
const GENERATED_AT = "2026-10-05T00:00:00.000Z"
const OWNED_AT = "2026-10-01T10:00:00.000Z"

const claimRow = {
  id: CLAIM,
  business_id: BIZ,
  observation_id: OBS,
  text: TEXT,
  origin: "MANUAL_TRANSCRIPTION",
  created_at: OWNED_AT,
}

const lineage = (): IssueLineage => ({
  business: { id: BIZ, name: "Acme" },
  claim: claimRow,
  observations: [
    {
      id: OBS,
      business_id: BIZ,
      check_run_id: RUN,
      question_id: QUESTION,
      question_prompt: PROMPT,
      provider: "mock",
      requested_model: "model-x",
      observed_model: "model-x",
      collected_at: OWNED_AT,
      answer_text: TEXT,
      measurement_context: {
        schema: schemaId.measurement,
        schema_version: PROTOCOL_VERSION,
        question: PROMPT,
        question_id: QUESTION,
        question_version: knownValue("v-test"),
        business_id: BIZ,
        surface: surfaceForWorker("mock", "model-x", "model-x"),
        observed_at: OWNED_AT,
        measurement_configuration: knownValue({ deterministic_fixture: true }),
        sample_number: 1,
        repeat_id: knownValue(RUN),
      },
      raw_digest_sha256: "a".repeat(64),
      raw_content_type: "text/plain",
      raw_received_at: OWNED_AT,
      raw_created_at: OWNED_AT,
      provider_metadata: null,
      created_at: OWNED_AT,
      synthetic: true,
    },
  ],
  citations: [],
  claims: [claimRow],
  judgments: [
    {
      id: JUDGMENT,
      business_id: BIZ,
      claim_id: CLAIM,
      verdict: "CONTRADICTED",
      notes: null,
      fact_ids: [],
      supersedes_id: null,
      created_at: "2026-10-01T11:00:00.000Z",
    },
  ],
  facts: [],
  interventions: [],
  reobservations: [],
})

const LineageStub = Layer.succeed(EvidenceLineageRepository, {
  loadIssue: (accountId: string, businessId: string, issueId: string) =>
    Effect.succeed(
      accountId === "acct-a" && businessId === BIZ && issueId === CLAIM ? lineage() : null,
    ),
})

const env = Layer.mergeAll(LineageStub)

describe("issue packet read model", () => {
  it("seals the issue packet: digest, empty signatures, lineage, rendering", async () => {
    const first = await Effect.runPromise(
      loadIssuePacket("acct-a", BIZ, CLAIM, GENERATED_AT).pipe(Effect.provide(env)),
    )
    expect(first).not.toBeNull()
    expect(first!.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(first!.digest).toBe(first!.packet.packet_digest)
    expect(first!.packet.signatures).toEqual([])
    expect(first!.packet.generated_at).toBe(GENERATED_AT)
    expect(first!.packet.issue.claim_id).toBe(CLAIM)
    expect(first!.packet.claims.map((c) => c.id)).toEqual([CLAIM])
    expect(first!.packet.judgments.map((j) => j.id)).toEqual([JUDGMENT])
    expect(first!.packet.observed_outcome).toBe("NOT_OBSERVED")
    expect(first!.rendered).toMatch(/^SYNTHETIC DATA\./)

    // Same stored state + pinned generatedAt => identical bytes and digest.
    const again = await Effect.runPromise(
      loadIssuePacket("acct-a", BIZ, CLAIM, GENERATED_AT).pipe(Effect.provide(env)),
    )
    expect(again!.digest).toBe(first!.digest)
    expect(serializePacket(again!.packet)).toBe(serializePacket(first!.packet))
  })

  it("keeps packets account-scoped and routes the read", async () => {
    expect(
      await Effect.runPromise(loadIssuePacket("acct-b", BIZ, CLAIM, GENERATED_AT).pipe(Effect.provide(env))),
    ).toBeNull()
    expect(await Effect.runPromise(loadIssuePacket("acct-a", BIZ, "unknown", GENERATED_AT).pipe(Effect.provide(env)))).toBeNull()

    const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8")
    expect(router).toContain("/api/businesses/:id/issues/:claimId/packet")
    expect(router).toContain("loadIssuePacket(")
  })
})
