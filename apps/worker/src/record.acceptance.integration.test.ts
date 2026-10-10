// ONE_AGENCY_THREE_CLIENTS_V1 acceptance, end to end through the real
// CheckRunner and the real Gemini grounding adapter, against a local HTTP
// server that plays Gemini with SYNTHETIC responses. Every agency, client,
// fact and reviewer here is a labelled TEST fixture.
// Requires TEST_DATABASE_URL (CI provides postgres; skipped otherwise).
import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Redacted, Schedule } from "effect"
import { PgClient } from "@effect/sql-pg"
import { NodeHttpClient } from "@effect/platform-node"
import pg from "pg"
import {
  CheckRunRepositoryLive, ObservationRepositoryLive, ProviderAttemptEvidenceRepositoryLive, QuestionRepositoryLive,
  RecordRepository, RecordRepositoryLive, operatorView, publicRecord, CAUSALITY_DISCLOSURE,
  type RecordDecision, type RecordSlot, type Session,
} from "@openrecord/db"
import { GeminiSettings } from "@openrecord/config"
import { GeminiProviderLive, MockProviderLive, NineRouterProvider, ProviderRegistryLive, ProviderUnsupported } from "@openrecord/providers"
import { CheckRunner, makeCheckRunnerLive } from "./check-runner.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const MODEL = "gemini-2.5-flash"

type Reply = { status: number; body: string }
const grounded = (text: string, sources: ReadonlyArray<[string, string]> = [["https://acme-hotel.test/rooms", "acme-hotel.test"]]): Reply => ({ status: 200, body: JSON.stringify({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", groundingMetadata: {
    webSearchQueries: ["TEST query"], groundingChunks: sources.map(([uri, title]) => ({ web: { uri, title } })), groundingSupports: [{ groundingChunkIndices: [0] }] } }],
  modelVersion: MODEL, responseId: `fixture-${randomUUID()}`,
}) })
const ungrounded = (text: string): Reply => ({ status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], modelVersion: MODEL }) })
const outage: Reply = { status: 503, body: "{}" }

suite("client record acceptance (TEST agency, TEST clients, TEST reviewer)", () => {
  let pool: pg.Pool
  let server: Server
  let port = 0
  /** Scripted Gemini replies per exact prompt, consumed in order. */
  const script = new Map<string, Reply[]>()
  const say = (prompt: string, ...replies: Reply[]) => script.set(prompt, [...(script.get(prompt) ?? []), ...replies])
  let runtime: ManagedRuntime.ManagedRuntime<RecordRepository | CheckRunner, unknown>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    server = createServer((req, res) => {
      let body = ""
      req.on("data", c => { body += c.toString() })
      req.on("end", () => {
        const prompt = (JSON.parse(body) as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0]!.parts[0]!.text
        const reply = script.get(prompt)?.shift() ?? { status: 500, body: "{}" }
        res.writeHead(reply.status, { "content-type": "application/json" })
        res.end(reply.body)
      })
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as { port: number }).port
    const PgLive = PgClient.layer({ url: Redacted.make(url) })
    const Repos = Layer.mergeAll(RecordRepositoryLive, CheckRunRepositoryLive, QuestionRepositoryLive, ObservationRepositoryLive, ProviderAttemptEvidenceRepositoryLive).pipe(Layer.provide(PgLive))
    const Gemini = GeminiProviderLive.pipe(Layer.provide(NodeHttpClient.layer), Layer.provide(Layer.succeed(GeminiSettings, {
      baseUrl: Redacted.make(`http://127.0.0.1:${port}/v1beta`), apiKey: Redacted.make("TEST-fixture-gemini-key"), model: MODEL, timeoutMs: 5000, responseMaxBytes: 1 << 20,
    })))
    const Providers = ProviderRegistryLive.pipe(Layer.provide(Layer.mergeAll(MockProviderLive, Gemini,
      Layer.succeed(NineRouterProvider, { observe: () => Effect.fail(new ProviderUnsupported({})) }))))
    const Runner = makeCheckRunnerLive(Schedule.recurs(0)).pipe(Layer.provide(Repos), Layer.provide(Providers))
    runtime = ManagedRuntime.make(Layer.mergeAll(Repos, Runner))
  })
  afterAll(async () => {
    await runtime.dispose(); await pool.end()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const records = <A, E>(fn: (r: RecordRepository["Type"]) => Effect.Effect<A, E>) => runtime.runPromise(Effect.flatMap(RecordRepository, fn))
  const drain = async (businessId: string) => {
    for (let i = 0; i < 20; i++) if (!await runtime.runPromise(Effect.flatMap(CheckRunner, r => r.runOnce({ businessId })))) return
    throw new Error("TEST queue did not drain")
  }
  const agency = async (): Promise<Session> => {
    const accountId = (await pool.query("INSERT INTO accounts (name) VALUES ('TEST Agency') RETURNING id")).rows[0].id as string
    const userId = (await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, 'TEST-only-not-a-password') RETURNING id", [`record-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users (account_id, user_id) VALUES ($1, $2)", [accountId, userId])
    return { accountId, userId }
  }
  interface SlotSpec { readonly slot: RecordSlot; readonly predicate: string; readonly value: string; readonly question: string }
  const client = async (session: Session, name: string, slots: ReadonlyArray<SlotSpec>) => {
    const c = await records(r => r.createClient(session, { name, websiteUrl: "https://acme-hotel.test/", engagement: "FIXTURE" }))
    for (const s of slots) {
      const item = await records(r => r.saveSlot(session, c.businessId, { slot: s.slot, subject: name, predicate: s.predicate, valueText: s.value,
        valueType: "TEXT", validFrom: "2026-01-01T00:00:00.000Z", validUntil: null, sourceUrl: "https://acme-hotel.test/rooms", question: s.question }))
      await records(r => r.approveItem(session, c.businessId, item.id))
    }
    return c.businessId
  }
  const run = async (session: Session, businessId: string) => {
    const r = await records(x => x.startRun(session, businessId, { kind: null, provider: "gemini", requestedModel: MODEL }))
    await drain(businessId)
    return r
  }
  const snapshot = async (businessId: string) => (await records(r => r.snapshot(businessId)))!
  /** Judge every answered check of a run, by slot. */
  const review = async (session: Session, businessId: string, runId: string, decisions: Partial<Record<RecordSlot, RecordDecision>>) => {
    const s = await snapshot(businessId)
    for (const check of s.checks.filter(c => c.runId === runId && c.observation !== null)) {
      const slot = s.items.find(i => i.id === check.itemId)!.slot
      const decision = decisions[slot]
      if (decision) await records(r => r.judge(session, businessId, { observationId: check.observation!.id, decision, note: "TEST reviewer internal note" }))
    }
  }

  const HOTEL: ReadonlyArray<SlotSpec> = [
    { slot: 1, predicate: "Check-in time", value: "3:00 PM", question: "What time is check-in at TEST Acme Hotel?" },
    { slot: 2, predicate: "Breakfast included", value: "Yes, breakfast is included", question: "Is breakfast included at TEST Acme Hotel?" },
    { slot: 3, predicate: "Airport shuttle", value: "Yes, a free airport shuttle runs hourly", question: "Does TEST Acme Hotel have an airport shuttle?" },
  ]

  it("Demo 1 + 2: three clients, initial record, public page, agency action, weekly OBSERVED_CORRECTION", async () => {
    const session = await agency()
    const a = await client(session, "TEST Acme Hotel", HOTEL)
    const b = await client(session, "TEST Acme Clinic", [
      { slot: 1, predicate: "Accepts new patients", value: "Yes", question: "Does TEST Acme Clinic accept new patients?" },
      { slot: 2, predicate: "Saturday opening", value: "09:00–13:00", question: "Is TEST Acme Clinic open on Saturday?" },
      { slot: 3, predicate: "Initial consultation", value: "$120", question: "How much is an initial consultation at TEST Acme Clinic?" },
    ])
    const c = await client(session, "TEST Acme Store", [
      { slot: 1, predicate: "Ships to Australia", value: "Yes", question: "Does TEST Acme Store ship to Australia?" },
      { slot: 2, predicate: "Free shipping threshold", value: "$80", question: "What is the free shipping threshold at TEST Acme Store?" },
      { slot: 3, predicate: "Returns window", value: "30 days", question: "What is the returns window at TEST Acme Store?" },
    ])
    const clients = await records(r => r.listClients(session.accountId))
    expect(clients.map(x => x.businessId).sort()).toEqual([a, b, c].sort())
    expect((await snapshot(b)).items.filter(i => i.approval !== null)).toHaveLength(3)
    expect((await snapshot(c)).items.filter(i => i.approval !== null)).toHaveLength(3)

    say(HOTEL[0]!.question, grounded("Check-in at TEST Acme Hotel starts at 3:00 PM."))
    say(HOTEL[1]!.question, grounded("Breakfast is available for an additional €20 per person.", [["https://old-listing.test/acme", "old-listing.test"]]))
    say(HOTEL[2]!.question, grounded("Some travellers mention a shuttle, but it is unclear whether one operates."))
    const initial = await run(session, a)
    let s = await snapshot(a)
    expect(operatorView(s).runs[0]).toMatchObject({ kind: "INITIAL", status: "SUCCEEDED" })
    // Raw answers and citations are persisted exactly as the adapter received them.
    const breakfast = s.checks.find(ch => s.items.find(i => i.id === ch.itemId)!.slot === 2)!.observation!
    expect(breakfast.answerText).toBe("Breakfast is available for an additional €20 per person.")
    expect(breakfast.retrievalMode).toBe("PROVIDER_GROUNDING")
    expect(breakfast.citations).toEqual([{ uri: "https://old-listing.test/acme", title: "old-listing.test", position: 1 }])
    const raw = (await pool.query("SELECT r.content_text FROM observations o JOIN raw_evidence r ON r.id = o.raw_evidence_id WHERE o.id = $1", [breakfast.id])).rows[0].content_text as string
    expect(raw).toContain("Breakfast is available for an additional €20 per person.")

    // Before review, nothing is public: answers are drafts.
    expect(publicRecord(s).facts.every(f => f.latest === null)).toBe(true)
    await review(session, a, initial.id, { 1: "MATCHES", 2: "CONTRADICTS", 3: "UNKNOWN" })
    await records(r => r.share(session, a))
    s = await snapshot(a)
    const page = publicRecord(s)
    expect(page.client).toEqual({ name: "TEST Acme Hotel", website: "https://acme-hotel.test/" })
    expect(page.fixture).toBe(true)
    expect(page.surface).toEqual({ name: "Gemini API", model: MODEL, retrievalTool: "Google Search grounding" })
    expect(page.facts.map(f => f.latest?.status === "ANSWERED" ? f.latest.judgment.decision : null)).toEqual(["MATCHES", "CONTRADICTS", "UNKNOWN"])
    const fact2 = page.facts[1]!
    expect(fact2.fact).toMatchObject({ label: "Breakfast included", value: "Yes, breakfast is included", source: "https://acme-hotel.test/rooms" })
    expect(fact2.question).toBe("Is breakfast included at TEST Acme Hotel?")
    expect(fact2.latest).toMatchObject({ status: "ANSWERED", answer: "Breakfast is available for an additional €20 per person.",
      retrieval: { requested: true, observed: true, tool: "Google Search grounding" }, citations: [{ url: "https://old-listing.test/acme", title: "old-listing.test" }],
      judgment: { label: "Contradicts the approved fact", reviewedBy: "Reviewed by the agency" } })
    expect(page.facts[2]!.latest).toMatchObject({ judgment: { decision: "UNKNOWN" } })
    // No score of any kind, no internal identity, note, key or raw payload.
    const text = JSON.stringify(page)
    expect(text).not.toMatch(/score|percent|%/i)
    for (const secret of [a, session.accountId, session.userId, breakfast.id, initial.id, ...s.items.map(i => i.id), ...s.checks.map(ch => ch.id),
      "TEST reviewer internal note", "TEST-fixture-gemini-key", "responseId", "groundingSupports"]) expect(text).not.toContain(secret)

    // Demo 2: the agency acts on the contradicted fact, then re-checks.
    await records(r => r.recordAction(session, a, { slot: 2, type: "SOURCE_UPDATED", note: "Updated the client pricing/service page.",
      links: ["https://acme-hotel.test/rooms"], performedAt: new Date().toISOString() }))
    expect(publicRecord(await snapshot(a)).facts[1]!.pendingActions).toEqual([{ performedAt: expect.any(String), note: "Updated the client pricing/service page.", links: ["https://acme-hotel.test/rooms"] }])
    say(HOTEL[0]!.question, grounded("Check-in at TEST Acme Hotel is from 3:00 PM."))
    say(HOTEL[1]!.question, grounded("Yes — breakfast is included in every room rate at TEST Acme Hotel."))
    say(HOTEL[2]!.question, grounded("It is still unclear whether TEST Acme Hotel runs a shuttle."))
    const followUp = await run(session, a)
    expect(followUp).toMatchObject({ kind: "FOLLOW_UP", baselineRunId: initial.id })
    // The follow-up is stored separately; the first answer is untouched.
    expect((await snapshot(a)).checks.find(ch => ch.observation?.id === breakfast.id)!.observation!.answerText).toBe("Breakfast is available for an additional €20 per person.")
    // Unreviewed follow-up stays private: the page still shows the first week.
    expect(publicRecord(await snapshot(a)).facts[1]!.comparison).toBeNull()
    await review(session, a, followUp.id, { 1: "MATCHES", 2: "MATCHES", 3: "UNKNOWN" })
    const after = publicRecord(await snapshot(a))
    const corrected = after.facts[1]!
    expect(corrected.comparison).toMatchObject({ outcome: "OBSERVED_CORRECTION",
      before: { judgment: { decision: "CONTRADICTS" }, answer: "Breakfast is available for an additional €20 per person." },
      actions: [{ note: "Updated the client pricing/service page." }],
      after: { judgment: { decision: "MATCHES" }, answer: "Yes — breakfast is included in every room rate at TEST Acme Hotel." } })
    expect(corrected.pendingActions).toEqual([])
    expect(after.facts[0]!.comparison).toMatchObject({ outcome: "INDETERMINATE", explanation: "The earlier answer already matched the approved fact, so there was no contradiction to verify a correction against. Both answers match." })
    expect(after.facts[2]!.comparison).toMatchObject({ outcome: "INDETERMINATE", explanation: "The earlier answer could not be judged against the approved fact." })
    expect(after.disclosure).toBe(CAUSALITY_DISCLOSURE)
    // Outside the disclosure (which denies it), nothing attributes the change.
    expect(JSON.stringify({ ...after, disclosure: null })).not.toMatch(/caused|because of|thanks to|led to|resulted in/i)
  })

  it("Demo 3: ugly INDETERMINATE — no retrieval, provider failure and ambiguity are shown, with reasons, on a PARTIALLY_SUCCEEDED run", async () => {
    const session = await agency()
    const slots: ReadonlyArray<SlotSpec> = [
      { slot: 1, predicate: "Check-in time", value: "3:00 PM", question: "What time is check-in at TEST Ugly Hotel?" },
      { slot: 2, predicate: "Breakfast included", value: "Yes", question: "Is breakfast included at TEST Ugly Hotel?" },
      { slot: 3, predicate: "Airport shuttle", value: "Yes", question: "Does TEST Ugly Hotel have an airport shuttle?" },
    ]
    const a = await client(session, "TEST Ugly Hotel", slots)
    say(slots[0]!.question, grounded("Check-in at TEST Ugly Hotel is at noon."))
    say(slots[1]!.question, grounded("Breakfast costs extra at TEST Ugly Hotel."))
    say(slots[2]!.question, grounded("TEST Ugly Hotel has no shuttle."))
    const initial = await run(session, a)
    await review(session, a, initial.id, { 1: "CONTRADICTS", 2: "CONTRADICTS", 3: "CONTRADICTS" })
    await records(r => r.recordAction(session, a, { slot: null, type: "SOURCE_UPDATED", note: "Agency updated /rooms.", links: [], performedAt: new Date().toISOString() }))
    say(slots[0]!.question, ungrounded("Check-in at TEST Ugly Hotel is at 3:00 PM."))
    say(slots[1]!.question, outage)
    say(slots[2]!.question, grounded("Reports about a TEST Ugly Hotel shuttle conflict."))
    const followUp = await run(session, a)
    const view = operatorView(await snapshot(a))
    // Partial evidence never becomes a clean success.
    expect(view.runs.find(r => r.id === followUp.id)!.status).toBe("PARTIALLY_SUCCEEDED")
    // The provider failure is visible to the operator with its class.
    const failed = view.runs.find(r => r.id === followUp.id)!.checks.find(ch => ch.status === "FAILED")!
    expect(failed.failureClass).toBe("PROVIDER_UNAVAILABLE")
    // The no-retrieval answer is still evidence, judged by the human.
    await review(session, a, followUp.id, { 1: "MATCHES", 3: "UNKNOWN" })
    const page = publicRecord(await snapshot(a))
    expect(page.facts.map(f => f.comparison?.outcome)).toEqual(["INDETERMINATE", "INDETERMINATE", "INDETERMINATE"])
    expect(page.facts[0]!.comparison!.explanation).toBe("Indeterminate — this answer did not use live web retrieval.")
    expect(page.facts[0]!.comparison!.after).toMatchObject({ retrieval: { requested: true, observed: false }, judgment: { decision: "MATCHES" } })
    expect(page.facts[1]!.comparison!.explanation).toBe("The later check could not be completed (the AI provider was unavailable), so there is no later answer to compare.")
    expect(page.facts[1]!.comparison!.after).toMatchObject({ status: "CHECK_FAILED" })
    expect(page.facts[2]!.comparison!.explanation).toBe("The later answer could not be judged against the approved fact.")
    // Record-level actions appear on every fact's comparison.
    expect(page.facts.every(f => f.comparison!.actions.some(x => x.note === "Agency updated /rooms."))).toBe(true)
    expect(page.disclosure).toBe(CAUSALITY_DISCLOSURE)
    // Nothing reran the failed check to get a prettier answer.
    expect((await pool.query("SELECT count(*)::int n FROM check_runs WHERE business_id = $1", [a])).rows[0].n).toBe(6)
  })

  it("CONTRADICTS → CONTRADICTS is NO_OBSERVED_CHANGE; a changed question or fact is INDETERMINATE", async () => {
    const session = await agency()
    const slots: ReadonlyArray<SlotSpec> = [
      { slot: 1, predicate: "Ships to Australia", value: "Yes", question: "Does TEST Same Store ship to Australia?" },
      { slot: 2, predicate: "Returns window", value: "30 days", question: "What is the returns window at TEST Same Store?" },
      { slot: 3, predicate: "Free shipping threshold", value: "$80", question: "What is the free shipping threshold at TEST Same Store?" },
    ]
    const a = await client(session, "TEST Same Store", slots)
    say(slots[0]!.question, grounded("TEST Same Store does not ship to Australia."), grounded("TEST Same Store only ships within the US."))
    say(slots[1]!.question, grounded("Returns are accepted for 14 days."))
    say(slots[2]!.question, grounded("Free shipping starts at $50."))
    const initial = await run(session, a)
    await review(session, a, initial.id, { 1: "CONTRADICTS", 2: "CONTRADICTS", 3: "CONTRADICTS" })
    // Slot 2: the operator rewords the question; slot 3: the approved fact changes.
    const reworded = "How many days do customers have to return items to TEST Same Store?"
    const item2 = await records(r => r.saveSlot(session, a, { slot: 2, subject: "TEST Same Store", predicate: "Returns window", valueText: "30 days", valueType: "TEXT",
      validFrom: "2026-01-01T00:00:00.000Z", validUntil: null, sourceUrl: "https://acme-hotel.test/rooms", question: reworded }))
    await records(r => r.approveItem(session, a, item2.id))
    const item3 = await records(r => r.saveSlot(session, a, { slot: 3, subject: "TEST Same Store", predicate: "Free shipping threshold", valueText: "$60", valueType: "TEXT",
      validFrom: "2026-01-01T00:00:00.000Z", validUntil: null, sourceUrl: "https://acme-hotel.test/rooms", question: slots[2]!.question }))
    await records(r => r.approveItem(session, a, item3.id))
    say(reworded, grounded("Customers have 30 days to return items."))
    say(slots[2]!.question, grounded("Free shipping starts at $60."))
    const followUp = await run(session, a)
    await review(session, a, followUp.id, { 1: "CONTRADICTS", 2: "MATCHES", 3: "MATCHES" })
    const page = publicRecord(await snapshot(a))
    expect(page.facts[0]!.comparison).toMatchObject({ outcome: "NO_OBSERVED_CHANGE", explanation: "No observed change. Both answers contradict the approved fact." })
    expect(page.facts[1]!.comparison).toMatchObject({ outcome: "INDETERMINATE", explanation: "The question changed between the two checks, so the answers are not compared." })
    expect(page.facts[2]!.comparison).toMatchObject({ outcome: "INDETERMINATE", explanation: "The approved fact changed between the two checks, so the answers are not compared." })
    // The earlier question is preserved exactly as asked.
    const s = await snapshot(a)
    expect(s.items.filter(i => i.slot === 2).map(i => i.question.prompt)).toEqual([slots[1]!.question, reworded])
    expect(page.facts[1]!.question).toBe(reworded)
  })

  it("run and review integrity: one active run, append-only judgment corrections, no implicit re-run", async () => {
    const session = await agency()
    const slots: ReadonlyArray<SlotSpec> = [{ slot: 1, predicate: "Check-in time", value: "3:00 PM", question: "What time is check-in at TEST Integrity Hotel?" }]
    const a = await client(session, "TEST Integrity Hotel", slots)
    say(slots[0]!.question, grounded("Check-in is at 3:00 PM."))
    const queued = await records(r => r.startRun(session, a, { kind: null, provider: "gemini", requestedModel: MODEL }))
    // A second click while the first run is in flight is refused.
    const second = await runtime.runPromise(Effect.either(Effect.flatMap(RecordRepository, r => r.startRun(session, a, { kind: null, provider: "gemini", requestedModel: MODEL }))))
    expect(second._tag === "Left" && second.left).toMatchObject({ _tag: "RecordRefused", reason: "RunInProgress" })
    await drain(a)
    const obs = (await snapshot(a)).checks[0]!.observation!
    const first = await records(r => r.judge(session, a, { observationId: obs.id, decision: "CONTRADICTS", note: null }))
    const corrected = await records(r => r.judge(session, a, { observationId: obs.id, decision: "MATCHES", note: "TEST misread" }))
    expect(corrected.supersedesId).toBe(first.id)
    const chain = (await snapshot(a)).checks[0]!.judgments
    expect(chain.map(j => j.decision)).toEqual(["CONTRADICTS", "MATCHES"])
    expect(publicRecord(await snapshot(a)).facts[0]!.latest).toMatchObject({ judgment: { decision: "MATCHES" } })
    await expect(pool.query("UPDATE record_judgments SET decision = 'UNKNOWN' WHERE id = $1", [first.id])).rejects.toThrow(/append-only/)
    await expect(pool.query("DELETE FROM record_judgments WHERE id = $1", [first.id])).rejects.toThrow(/append-only/)
    await expect(pool.query("UPDATE observations SET answer_text = 'rewritten' WHERE id = $1", [obs.id])).rejects.toThrow()
    const bound = (await snapshot(a)).items[0]!
    await expect(pool.query("UPDATE authoritative_facts SET value_text = 'rewritten' WHERE id = $1", [bound.fact.id])).rejects.toThrow(/immutable/)
    await expect(pool.query("UPDATE buyer_questions SET prompt = 'rewritten' WHERE id = $1", [bound.question.id])).rejects.toThrow(/immutable/)
    await expect(pool.query("UPDATE check_runs SET requested_model = 'another-model' WHERE record_run_id = $1", [queued.id])).rejects.toThrow(/immutable/)
    // A reviewer outside the agency cannot be recorded, even directly.
    const outsider = await agency()
    await expect(pool.query("INSERT INTO record_judgments (business_id, observation_id, item_id, decision, reviewed_by_user_id) SELECT business_id, $1, record_item_id, 'MATCHES', $2 FROM check_runs WHERE id = $3",
      [obs.id, outsider.userId, (await snapshot(a)).checks[0]!.id])).rejects.toThrow(/account user/)
    // Finished checks are not re-opened by a repeated finalization.
    await pool.query("UPDATE check_runs SET status = 'SUCCEEDED' WHERE id = $1 AND status = 'RUNNING'", [(await snapshot(a)).checks[0]!.id])
    expect((await snapshot(a)).checks).toHaveLength(1)
    expect(queued.kind).toBe("INITIAL")
    // Unapproved slot versions are never checked.
    const draft = await records(r => r.saveSlot(session, a, { slot: 1, subject: "TEST Integrity Hotel", predicate: "Check-in time", valueText: "4:00 PM", valueType: "TEXT",
      validFrom: "2026-01-01T00:00:00.000Z", validUntil: null, sourceUrl: "https://acme-hotel.test/rooms", question: slots[0]!.question }))
    expect(draft.approval).toBeNull()
    const none = await runtime.runPromise(Effect.either(Effect.flatMap(RecordRepository, r => r.startRun(session, a, { kind: null, provider: "gemini", requestedModel: MODEL }))))
    expect(none._tag === "Left" && none.left).toMatchObject({ reason: "NoApprovedFacts" })
    // Unapproved facts are not on the public page either.
    expect(publicRecord(await snapshot(a)).facts).toEqual([])
  })
})
