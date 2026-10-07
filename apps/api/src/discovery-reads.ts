import { Effect } from "effect"
import {
  DiscoveryMatchRepository,
  DiscoveryObservationRepository,
  DiscoveryRunRepository,
  DiscoveryScopeRepository,
  FactRepository,
  ProductReadRepository,
  type DiscoveryMatchRow,
  type DiscoveryObservationRow,
  type DiscoveryRunRow,
} from "@openrecord/db"
import {
  buildAuthoritySnapshot,
  DiscoveryScopeInvalid,
  validateScope,
  type FactRowInput,
} from "@openrecord/discovery"
import { scopedBusiness } from "./reads.js"

// ---------------------------------------------------------------------------
// Representation Discovery V1 read model. Candidates are derived at read time
// by grouping discovery_matches per page + lineage; they are never stored as
// verification state and never surface as IN_SYNC/DRIFT findings.
// ---------------------------------------------------------------------------

/** Boundary validation for POST /discovery/scopes {root_url}. */
export const validateDiscoveryScopeRoot = (
  raw: unknown,
): { ok: true; rootUrl: string; canonicalOrigin: string; pathPrefix: string } | { ok: false; reason: string } => {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "root_url required" }
  const trimmed = raw.trim()
  if (trimmed.length > 2048) return { ok: false, reason: "root_url too long" }
  try {
    const v = validateScope(trimmed)
    return { ok: true, rootUrl: trimmed, canonicalOrigin: v.canonical_origin, pathPrefix: v.path_prefix }
  } catch (e) {
    if (e instanceof DiscoveryScopeInvalid) {
      if (e.code === "UNSUPPORTED_SCHEME") return { ok: false, reason: "bad scheme (http/https only)" }
      if (e.code === "CREDENTIALS_REJECTED") return { ok: false, reason: "credentials rejected" }
      return { ok: false, reason: "invalid URL" }
    }
    return { ok: false, reason: "invalid URL" }
  }
}

/** True when the scope already has a QUEUED or RUNNING run (POST -> 409). */
export const isDuplicateActiveRun = (
  runs: ReadonlyArray<{ scopeId: string; state: string }>,
  scopeId: string,
): boolean => runs.some((r) => r.scopeId === scopeId && (r.state === "QUEUED" || r.state === "RUNNING"))

export interface DiscoveryCandidateEvidence {
  readonly surface: string
  readonly locator: string
  readonly snippet: string
  readonly relation: "CURRENT" | "HISTORICAL"
}

export interface DiscoveryCandidateDto {
  readonly id: string
  readonly run_id: string
  readonly scope_id: string
  readonly fact_id: string
  readonly fact_predicate: string
  readonly approved_value: string
  readonly found_value: string
  readonly page_url: string
  readonly relation: "CURRENT" | "HISTORICAL" | "MIXED"
  readonly found_via: string
  readonly scanned_at: string
  readonly truth_changed_since_scan: boolean
  readonly surfaces: ReadonlyArray<string>
  readonly match_count: number
  readonly evidence: ReadonlyArray<DiscoveryCandidateEvidence>
  readonly matcher_version: string
  readonly authority_digest: string | null
  readonly observation_id: string
}

interface CandidateMatchInput {
  readonly runId: string
  readonly pageObservationId: string
  readonly lineageRootFactId: string
  readonly matchedValue: string
  readonly matchSurface: string
  readonly evidenceLocator: string
  readonly evidenceSnippet: string
  readonly relationAtScan: string
  readonly matcherVersion: string
}

interface CandidateObservationInput {
  readonly finalUrl: string
  readonly discoveredVia: string
  readonly completedAt: string
}

interface CandidateRunInput {
  readonly scopeId: string
  readonly authoritySnapshotDigest: string | null
}

interface CandidateFactInput {
  readonly predicate: string
  readonly approvedValue: string
}

/**
 * Group match rows per page + lineage. CURRENT when only the current value
 * matched, HISTORICAL when only older values matched, MIXED when more than
 * one known value matched. Deterministic order (page, lineage root).
 */
export const groupDiscoveryCandidates = (args: {
  readonly matches: ReadonlyArray<CandidateMatchInput>
  readonly observations: ReadonlyMap<string, CandidateObservationInput>
  readonly runs: ReadonlyMap<string, CandidateRunInput>
  readonly facts: ReadonlyMap<string, CandidateFactInput>
  readonly currentDigest: string | null
}): DiscoveryCandidateDto[] => {
  const byPageLineage = new Map<string, CandidateMatchInput[]>()
  for (const m of args.matches) {
    const key = `${m.pageObservationId} ${m.lineageRootFactId}`
    const list = byPageLineage.get(key) ?? []
    list.push(m)
    byPageLineage.set(key, list)
  }
  const out: DiscoveryCandidateDto[] = []
  for (const [key, list] of byPageLineage) {
    const first = list[0] as CandidateMatchInput
    const obs = args.observations.get(first.pageObservationId)
    const run = args.runs.get(first.runId)
    const fact = args.facts.get(first.lineageRootFactId)
    if (!obs || !run || !fact) continue
    const current = list.filter((m) => m.relationAtScan === "CURRENT_VALUE")
    const historical = list.filter((m) => m.relationAtScan === "HISTORICAL_VALUE")
    const relation = current.length > 0 && historical.length > 0 ? "MIXED" : current.length > 0 ? "CURRENT" : "HISTORICAL"
    const found = current.length > 0 ? (current[0] as CandidateMatchInput).matchedValue : (first as CandidateMatchInput).matchedValue
    const surfaces = [...new Set(list.map((m) => m.matchSurface))].sort()
    const evidence: DiscoveryCandidateEvidence[] = list.slice(0, 5).map((m) => ({
      surface: m.matchSurface,
      locator: m.evidenceLocator,
      snippet: m.evidenceSnippet,
      relation: m.relationAtScan === "HISTORICAL_VALUE" ? "HISTORICAL" : "CURRENT",
    }))
    const runDigest = run.authoritySnapshotDigest
    out.push({
      id: `${first.runId}:${first.pageObservationId}:${first.lineageRootFactId}`,
      run_id: first.runId,
      scope_id: run.scopeId,
      fact_id: first.lineageRootFactId,
      fact_predicate: fact.predicate,
      approved_value: fact.approvedValue,
      found_value: found,
      page_url: obs.finalUrl,
      relation,
      found_via: obs.discoveredVia,
      scanned_at: obs.completedAt,
      // Conservative: an undeterminable current digest warns, never stays silent.
      truth_changed_since_scan: args.currentDigest === null || runDigest === null || runDigest !== args.currentDigest,
      surfaces,
      match_count: list.length,
      evidence,
      matcher_version: (first as CandidateMatchInput).matcherVersion,
      authority_digest: runDigest,
      observation_id: first.pageObservationId,
    })
    void key
  }
  return out.sort((a, b) => (a.page_url < b.page_url ? -1 : a.page_url > b.page_url ? 1 : a.fact_id < b.fact_id ? -1 : 1))
}

/** Authenticated discovery scope list for one business. */
export const loadDiscoveryScopes = (accountId: string, businessId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const scopes = yield* DiscoveryScopeRepository
    return yield* scopes.listByBusiness(businessId)
  })

/** Authenticated discovery run list for one business (optionally one scope). */
export const loadDiscoveryRuns = (accountId: string, businessId: string, scopeId?: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const scopes = yield* DiscoveryScopeRepository
    const runs = yield* DiscoveryRunRepository
    if (scopeId !== undefined) {
      if (!(yield* scopes.getScoped(businessId, scopeId))) return null
      return yield* runs.listByScope(businessId, scopeId)
    }
    const all = yield* scopes.listByBusiness(businessId)
    const per = yield* Effect.forEach(all, (s) => runs.listByScope(businessId, s.id))
    return per.flat().sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : a.queuedAt > b.queuedAt ? -1 : 0))
  })

/** Compute the live authority digest with the worker's snapshot rule. */
export const loadCurrentAuthorityDigest = (accountId: string, businessId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const factsRepo = yield* FactRepository
    const reads = yield* ProductReadRepository
    const all = yield* factsRepo.listByBusiness(businessId)
    const byId = new Map<string, FactRowInput>()
    for (const f of all.filter((row) => row.status === "ACTIVE")) {
      const lineage = (yield* reads.factLineage(businessId, f.id).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )) as Array<Record<string, unknown>> | null
      if (!lineage || lineage.length === 0) continue
      let root: string | null = null
      for (const r of lineage) {
        if ((r["supersedes_id"] as string | null) === null) {
          root = String(r["id"])
          break
        }
      }
      if (root === null) {
        const sorted = [...lineage].sort((a, b) => Number(a["version"]) - Number(b["version"]))
        const first = sorted[0]
        root = first ? String(first["id"]) : f.id
      }
      for (const r of lineage) {
        const id = String(r["id"])
        if (byId.has(id)) continue
        const vt = String(r["value_type"] ?? "TEXT")
        byId.set(id, {
          id,
          lineageRootId: root,
          version: Number(r["version"] ?? 1),
          valueType: vt === "CURRENCY" ? "CURRENCY" : vt === "BOOLEAN" ? "BOOLEAN" : "TEXT",
          valueText: String(r["value_text"] ?? ""),
          supersedesId: (r["supersedes_id"] as string | null) ?? null,
        })
      }
    }
    if (byId.size === 0) {
      const activeCount = all.filter((row) => row.status === "ACTIVE").length
      if (activeCount > 0) return null
      return buildAuthoritySnapshot([]).digest
    }
    try {
      return buildAuthoritySnapshot([...byId.values()]).digest
    } catch {
      return null
    }
  })

/** Authenticated candidate list: matches grouped per page + lineage. */
export const loadDiscoveryCandidates = (
  accountId: string,
  businessId: string,
  opts: { scopeId?: string; runId?: string },
) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const scopes = yield* DiscoveryScopeRepository
    const runsRepo = yield* DiscoveryRunRepository
    const matchesRepo = yield* DiscoveryMatchRepository
    const obsRepo = yield* DiscoveryObservationRepository
    const factsRepo = yield* FactRepository
    let runs: ReadonlyArray<DiscoveryRunRow>
    if (opts.runId !== undefined) {
      const run = yield* runsRepo.getScoped(businessId, opts.runId)
      if (!run) return null
      if (opts.scopeId !== undefined && run.scopeId !== opts.scopeId) return null
      if (opts.scopeId !== undefined && !(yield* scopes.getScoped(businessId, opts.scopeId))) return null
      runs = [run]
    } else if (opts.scopeId !== undefined) {
      if (!(yield* scopes.getScoped(businessId, opts.scopeId))) return null
      runs = yield* runsRepo.listByScope(businessId, opts.scopeId)
    } else {
      return { candidates: [] as DiscoveryCandidateDto[] }
    }
    const matches: DiscoveryMatchRow[] = []
    const observations = new Map<string, DiscoveryObservationRow>()
    const runInputs = new Map<string, { scopeId: string; authoritySnapshotDigest: string | null }>()
    for (const run of runs) {
      runInputs.set(run.id, { scopeId: run.scopeId, authoritySnapshotDigest: run.authoritySnapshotDigest })
      for (const m of yield* matchesRepo.listByRun(businessId, run.id)) matches.push(m)
      for (const o of yield* obsRepo.listByRun(businessId, run.id)) observations.set(o.id, o)
    }
    const roots = [...new Set(matches.map((m) => m.lineageRootFactId))].sort()
    const factInputs = new Map<string, { predicate: string; approvedValue: string }>()
    const reads = yield* ProductReadRepository
    for (const rootId of roots) {
      const root = yield* factsRepo.getScoped(businessId, rootId)
      if (!root) continue
      const lineage = (yield* reads.factLineage(businessId, rootId).pipe(
        Effect.catchAll(() => Effect.succeed([] as Array<Record<string, unknown>>)),
      )) as Array<Record<string, unknown>>
      const activeRow = lineage.find((r) => String(r["status"]) === "ACTIVE")
      factInputs.set(rootId, {
        predicate: root.predicate,
        approvedValue: activeRow ? String(activeRow["value_text"] ?? root.valueText) : root.valueText,
      })
    }
    const currentDigest = yield* loadCurrentAuthorityDigest(accountId, businessId)
    const candidates = groupDiscoveryCandidates({
      matches: matches.map((m) => ({
        runId: m.runId,
        pageObservationId: m.pageObservationId,
        lineageRootFactId: m.lineageRootFactId,
        matchedValue: m.matchedValue,
        matchSurface: m.matchSurface,
        evidenceLocator: m.evidenceLocator,
        evidenceSnippet: m.evidenceSnippet,
        relationAtScan: m.relationAtScan,
        matcherVersion: m.matcherVersion,
      })),
      observations: new Map(
        [...observations.values()].map((o) => [o.id, { finalUrl: o.finalUrl, discoveredVia: o.discoveredVia, completedAt: o.completedAt }]),
      ),
      runs: runInputs,
      facts: factInputs,
      currentDigest,
    })
    return { candidates }
  })
