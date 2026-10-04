// Discovery V1 API boundary: tenancy (cross-account invisibility),
// duplicate-active-run conflicts, and scope validation. DB-free: stubbed
// Effect layers plus the pure grouping/validation helpers.
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  BusinessRepository,
  DiscoveryMatchRepository,
  DiscoveryObservationRepository,
  DiscoveryRunRepository,
  DiscoveryScopeRepository,
  FactRepository,
  ProductReadRepository,
} from "@ghostping/db"
import {
  groupDiscoveryCandidates,
  isDuplicateActiveRun,
  loadDiscoveryCandidates,
  loadDiscoveryRuns,
  loadDiscoveryScopes,
  validateDiscoveryScopeRoot,
} from "./discovery-reads.js"

const BIZ_A = "11111111-1111-4111-8111-111111111111"
const SCOPE_A = "22222222-2222-4222-8222-222222222222"
const RUN_A = "33333333-3333-4333-8333-333333333333"

const BusinessStub = Layer.succeed(BusinessRepository, {
  create: () => Effect.dieMessage("unused"),
  list: () => Effect.succeed([]),
  getScoped: (accountId: string, id: string) =>
    Effect.succeed(accountId === "acct-a" && id === BIZ_A ? { id: BIZ_A, accountId: "acct-a", name: "Acme", createdAt: new Date().toISOString() } : null),
})

const ScopeStub = Layer.succeed(DiscoveryScopeRepository, {
  create: () => Effect.dieMessage("unused"),
  listByBusiness: (businessId: string) =>
    Effect.succeed(
      businessId === BIZ_A
        ? [{ id: SCOPE_A, businessId: BIZ_A, rootUrl: "https://acme.example/", canonicalOrigin: "https://acme.example", pathPrefix: "/", enabled: true, ownershipAssertion: "OPERATOR_ASSERTED_OWNED", createdAt: new Date().toISOString() }]
        : [],
    ),
  getScoped: (businessId: string, scopeId: string) =>
    Effect.succeed(businessId === BIZ_A && scopeId === SCOPE_A
      ? { id: SCOPE_A, businessId: BIZ_A, rootUrl: "https://acme.example/", canonicalOrigin: "https://acme.example", pathPrefix: "/", enabled: true, ownershipAssertion: "OPERATOR_ASSERTED_OWNED", createdAt: new Date().toISOString() }
      : null),
})

const RunStub = (runs: Array<{ id: string; scopeId: string; state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" }>) =>
  Layer.succeed(DiscoveryRunRepository, {
    enqueue: () => Effect.dieMessage("unused"),
    listByScope: (businessId: string, scopeId: string) =>
      Effect.succeed(
        businessId === BIZ_A && scopeId === SCOPE_A
          ? runs.map((r) => ({
            id: r.id,
            businessId: BIZ_A,
            scopeId: SCOPE_A,
            authoritySnapshotDigest: "digest-1",
            matcherVersion: "discovery-matcher/1",
            policyVersion: "discovery-policy/1",
            state: r.state,
            queuedAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            heartbeatAt: null,
            attemptCount: 0,
            failureClass: null,
            failureDetailSafe: null,
            pagesFetched: 0,
            pagesNotModified: 0,
            pagesFailed: 0,
            pagesSkippedRobots: 0,
            bytesDownloaded: 0,
            candidatesFound: 0,
          }))
          : [],
      ),
    getScoped: (businessId: string, runId: string) =>
      Effect.succeed(
        businessId === BIZ_A && runs.some((r) => r.id === runId)
          ? {
            id: runId,
            businessId: BIZ_A,
            scopeId: SCOPE_A,
            authoritySnapshotDigest: "digest-1",
            matcherVersion: "discovery-matcher/1",
            policyVersion: "discovery-policy/1",
            state: "SUCCEEDED" as const,
            queuedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            heartbeatAt: null,
            attemptCount: 1,
            failureClass: null,
            failureDetailSafe: null,
            pagesFetched: 1,
            pagesNotModified: 0,
            pagesFailed: 0,
            pagesSkippedRobots: 0,
            bytesDownloaded: 128,
            candidatesFound: 1,
          }
          : null,
      ),
    claimOne: () => Effect.succeed(null),
    claimAny: () => Effect.succeed(null),
    heartbeat: () => Effect.void,
    setAuthorityDigest: () => Effect.void,
    incrementCounters: () => Effect.void,
    markFinished: () => Effect.void,
  })

const EmptyMatchStub = Layer.succeed(DiscoveryMatchRepository, {
  insertMany: () => Effect.succeed([]),
  listByRun: () => Effect.succeed([]),
  latestEffectiveMatches: () => Effect.succeed([]),
})

const EmptyObsStub = Layer.succeed(DiscoveryObservationRepository, {
  insert: () => Effect.dieMessage("unused"),
  listByRun: () => Effect.succeed([]),
  latestValidators: () => Effect.succeed(null),
})

const EmptyFactStub = Layer.succeed(FactRepository, {
  create: () => Effect.dieMessage("unused"),
  listByBusiness: () => Effect.succeed([]),
  getScoped: () => Effect.succeed(null),
  supersede: () => Effect.dieMessage("unused"),
  retire: () => Effect.succeed(null),
  activeOverlapping: () => Effect.succeed([]),
})

const EmptyReadsStub = Layer.succeed(ProductReadRepository, {
  authorityMode: () => Effect.succeed(null),
  factProvenance: () => Effect.succeed([]),
  factHistory: () => Effect.succeed([]),
  factLineage: () => Effect.succeed([]),
  targets: () => Effect.succeed([]),
  bindings: () => Effect.succeed([]),
  binding: () => Effect.succeed(null),
  observations: () => Effect.succeed([]),
  values: () => Effect.succeed([]),
  aiCitations: () => Effect.succeed([]),
  createBinding: () => Effect.dieMessage("unused"),
  findBindingExact: () => Effect.succeed(null),
  issueList: () => Effect.succeed([]),
  issueDetailRow: () => Effect.succeed(null),
})

const AllStubs = (runs: Array<{ id: string; scopeId: string; state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" }>) =>
  Layer.mergeAll(BusinessStub, ScopeStub, RunStub(runs), EmptyMatchStub, EmptyObsStub, EmptyFactStub, EmptyReadsStub)

describe("validateDiscoveryScopeRoot", () => {
  it("accepts https roots with a path prefix", () => {
    const out = validateDiscoveryScopeRoot("https://acme.example/docs/")
    expect(out).toEqual({ ok: true, rootUrl: "https://acme.example/docs/", canonicalOrigin: "https://acme.example", pathPrefix: "/docs" })
  })

  it("rejects non-http schemes", () => {
    for (const bad of ["ftp://acme.example/", "javascript:alert(1)", "data:text/plain,hi", "file:///etc/passwd"]) {
      const out = validateDiscoveryScopeRoot(bad)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toMatch(/scheme|invalid/i)
    }
  })

  it("rejects embedded credentials", () => {
    const out = validateDiscoveryScopeRoot("https://user:pass@acme.example/")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/credentials/i)
  })

  it("rejects missing and empty roots", () => {
    expect(validateDiscoveryScopeRoot(null).ok).toBe(false)
    expect(validateDiscoveryScopeRoot("").ok).toBe(false)
    expect(validateDiscoveryScopeRoot(undefined).ok).toBe(false)
  })
})

describe("isDuplicateActiveRun", () => {
  it("conflicts on QUEUED or RUNNING for the same scope", () => {
    expect(isDuplicateActiveRun([{ scopeId: SCOPE_A, state: "QUEUED" }], SCOPE_A)).toBe(true)
    expect(isDuplicateActiveRun([{ scopeId: SCOPE_A, state: "RUNNING" }], SCOPE_A)).toBe(true)
  })

  it("allows new runs after terminal states or for other scopes", () => {
    for (const state of ["SUCCEEDED", "PARTIAL", "FAILED"]) {
      expect(isDuplicateActiveRun([{ scopeId: SCOPE_A, state }], SCOPE_A)).toBe(false)
    }
    expect(isDuplicateActiveRun([{ scopeId: SCOPE_A, state: "RUNNING" }], "other-scope")).toBe(false)
    expect(isDuplicateActiveRun([], SCOPE_A)).toBe(false)
  })
})

describe("groupDiscoveryCandidates", () => {
  const obs = new Map([["o1", { finalUrl: "https://acme.example/pricing", discoveredVia: "SITEMAP", completedAt: "2026-10-03T10:00:00.000Z" }]])
  const runs = new Map([[RUN_A, { scopeId: SCOPE_A, authoritySnapshotDigest: "digest-1" }]])
  const facts = new Map([["f-root", { predicate: "monthly price", approvedValue: "59 USD" }]])
  const match = (
    relationAtScan: string,
    matchedValue: string,
    overrides?: { matchSurface?: string; evidenceLocator?: string; evidenceSnippet?: string },
  ) => ({
    runId: RUN_A,
    pageObservationId: "o1",
    lineageRootFactId: "f-root",
    matchedValue,
    matchSurface: overrides?.matchSurface ?? "VISIBLE_TEXT",
    evidenceLocator: overrides?.evidenceLocator ?? "body.main",
    evidenceSnippet: overrides?.evidenceSnippet ?? `${matchedValue} per month`,
    relationAtScan,
    matcherVersion: "discovery-matcher/1",
  })

  it("labels CURRENT, HISTORICAL, and MIXED per page+lineage", () => {
    const current = groupDiscoveryCandidates({ matches: [match("CURRENT_VALUE", "59 USD")], observations: obs, runs, facts, currentDigest: "digest-1" })
    expect(current).toHaveLength(1)
    expect(current[0]?.relation).toBe("CURRENT")
    expect(current[0]?.found_value).toBe("59 USD")
    expect(current[0]?.approved_value).toBe("59 USD")
    expect(current[0]?.truth_changed_since_scan).toBe(false)

    const historical = groupDiscoveryCandidates({ matches: [match("HISTORICAL_VALUE", "49 USD")], observations: obs, runs, facts, currentDigest: "digest-1" })
    expect(historical[0]?.relation).toBe("HISTORICAL")

    const mixed = groupDiscoveryCandidates({
      matches: [match("CURRENT_VALUE", "59 USD"), { ...match("HISTORICAL_VALUE", "49 USD"), matchSurface: "META" }],
      observations: obs,
      runs,
      facts,
      currentDigest: "digest-1",
    })
    expect(mixed[0]?.relation).toBe("MIXED")
    expect(mixed[0]?.surfaces).toEqual(["META", "VISIBLE_TEXT"])
    expect(mixed[0]?.match_count).toBe(2)
  })

  it("warns when authority moved since the scan", () => {
    const moved = groupDiscoveryCandidates({ matches: [match("CURRENT_VALUE", "59 USD")], observations: obs, runs, facts, currentDigest: "digest-2" })
    expect(moved[0]?.truth_changed_since_scan).toBe(true)
    const unknown = groupDiscoveryCandidates({ matches: [match("CURRENT_VALUE", "59 USD")], observations: obs, runs, facts, currentDigest: null })
    expect(unknown[0]?.truth_changed_since_scan).toBe(true)
  })

  it("drops groups with missing evidence instead of leaking", () => {
    const missing = groupDiscoveryCandidates({
      matches: [match("CURRENT_VALUE", "59 USD")],
      observations: new Map(),
      runs,
      facts,
      currentDigest: "digest-1",
    })
    expect(missing).toEqual([])
  })

  it("304-reused rows (explicit provenance) group exactly like fresh rows", () => {
    // Reuse rows share the new 304 observation id and carry provenance in
    // the DB layer only; grouping sees identical page+lineage keys, so the
    // second run's candidate list equals the first run's.
    const reused = groupDiscoveryCandidates({
      matches: [
        { ...match("CURRENT_VALUE", "59 USD"), pageObservationId: "o2" },
        { ...match("HISTORICAL_VALUE", "49 USD"), pageObservationId: "o2", matchSurface: "META" },
      ],
      observations: new Map([["o2", { finalUrl: "https://acme.example/pricing", discoveredVia: "SITEMAP", completedAt: "2026-10-03T11:00:00.000Z" }]]),
      runs,
      facts,
      currentDigest: "digest-1",
    })
    expect(reused).toHaveLength(1)
    expect(reused[0]?.relation).toBe("MIXED")
    expect(reused[0]?.observation_id).toBe("o2")
    expect(reused[0]?.match_count).toBe(2)
  })

  it("candidate count equals distinct page+lineage groups", () => {
    const matches = [
      match("CURRENT_VALUE", "59 USD"),
      { ...match("CURRENT_VALUE", "59 USD"), matchSurface: "META" },
      { ...match("HISTORICAL_VALUE", "49 USD"), lineageRootFactId: "f-root-2" },
    ]
    const grouped = groupDiscoveryCandidates({
      matches,
      observations: obs,
      runs,
      facts: new Map([
        ["f-root", { predicate: "monthly price", approvedValue: "59 USD" }],
        ["f-root-2", { predicate: "seat limit", approvedValue: "10 seats" }],
      ]),
      currentDigest: "digest-1",
    })
    // Two logical candidates (one per lineage) regardless of event count.
    expect(grouped).toHaveLength(2)
  })

  it("exposes per-match evidence with surface, locator, and snippet", () => {
    const grouped = groupDiscoveryCandidates({
      matches: [match("CURRENT_VALUE", "59 USD", { evidenceLocator: "meta:octolytics-dimension-foo", evidenceSnippet: "Starter is 59 USD per month" })],
      observations: obs,
      runs,
      facts,
      currentDigest: "digest-1",
    })
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.evidence).toEqual([
      { surface: "VISIBLE_TEXT", locator: "meta:octolytics-dimension-foo", snippet: "Starter is 59 USD per month", relation: "CURRENT" },
    ])
  })

  it("caps evidence at the first 5 entries while match_count stays total", () => {
    const matches = Array.from({ length: 7 }, (_, i) =>
      match("CURRENT_VALUE", "59 USD", { evidenceLocator: `body.row-${i}`, evidenceSnippet: `snippet ${i}` }),
    )
    const grouped = groupDiscoveryCandidates({ matches, observations: obs, runs, facts, currentDigest: "digest-1" })
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.match_count).toBe(7)
    expect(grouped[0]?.evidence).toHaveLength(5)
    expect(grouped[0]?.evidence.map((e) => e.locator)).toEqual(["body.row-0", "body.row-1", "body.row-2", "body.row-3", "body.row-4"])
  })

  it("maps evidence relations to CURRENT/HISTORICAL display values", () => {
    const grouped = groupDiscoveryCandidates({
      matches: [
        match("CURRENT_VALUE", "59 USD", { matchSurface: "VISIBLE_TEXT", evidenceLocator: "body.main", evidenceSnippet: "59 USD now" }),
        match("HISTORICAL_VALUE", "49 USD", { matchSurface: "META", evidenceLocator: "meta:octolytics-dimension-bar", evidenceSnippet: "was 49 USD" }),
      ],
      observations: obs,
      runs,
      facts,
      currentDigest: "digest-1",
    })
    expect(grouped[0]?.relation).toBe("MIXED")
    expect(grouped[0]?.evidence.map((e) => e.relation)).toEqual(["CURRENT", "HISTORICAL"])
    expect(grouped[0]?.evidence.map((e) => e.surface)).toEqual(["VISIBLE_TEXT", "META"])
  })
})

describe("discovery tenancy", () => {
  it("account B sees no scopes of account A", async () => {
    const a = await Effect.runPromise(loadDiscoveryScopes("acct-a", BIZ_A).pipe(Effect.provide(AllStubs([]))))
    expect(a).toHaveLength(1)
    const b = await Effect.runPromise(loadDiscoveryScopes("acct-b", BIZ_A).pipe(Effect.provide(AllStubs([]))))
    expect(b).toBeNull()
  })

  it("account B sees no runs of account A", async () => {
    const a = await Effect.runPromise(
      loadDiscoveryRuns("acct-a", BIZ_A, SCOPE_A).pipe(Effect.provide(AllStubs([{ id: RUN_A, scopeId: SCOPE_A, state: "SUCCEEDED" }]))),
    )
    expect(a).toHaveLength(1)
    const b = await Effect.runPromise(
      loadDiscoveryRuns("acct-b", BIZ_A, SCOPE_A).pipe(Effect.provide(AllStubs([{ id: RUN_A, scopeId: SCOPE_A, state: "SUCCEEDED" }]))),
    )
    expect(b).toBeNull()
  })

  it("account B sees no candidates of account A", async () => {
    const b = await Effect.runPromise(
      loadDiscoveryCandidates("acct-b", BIZ_A, { scopeId: SCOPE_A }).pipe(
        Effect.provide(AllStubs([{ id: RUN_A, scopeId: SCOPE_A, state: "SUCCEEDED" }])),
      ),
    )
    expect(b).toBeNull()
  })

  it("duplicate active runs are detected from the run list", async () => {
    const runs = (await Effect.runPromise(
      loadDiscoveryRuns("acct-a", BIZ_A, SCOPE_A).pipe(Effect.provide(AllStubs([{ id: RUN_A, scopeId: SCOPE_A, state: "RUNNING" }]))),
    )) ?? []
    expect(isDuplicateActiveRun(runs, SCOPE_A)).toBe(true)
  })
})
