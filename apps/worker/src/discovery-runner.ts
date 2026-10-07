// DiscoveryRunner: claims one QUEUED discovery run (atomic single-statement
// ownership with lease reclaim), freezes the authority snapshot, crawls the
// scope through the shared SafeHttpFetcher, matches page bodies against
// frozen lineage values via @openrecord/discovery, and transitions RUNNING ->
// SUCCEEDED | PARTIAL | FAILED.
//
// Terminal semantics:
// - SUCCEEDED = bounded traversal complete, every fetched page evaluated.
// - PARTIAL   = budget/deadline stop (BUDGET_EXHAUSTED) or some page failures
//               with page evidence (PAGE_FAILURES).
// - FAILED    = invalid scope, robots denied/unavailable, unusable authority
//               (UNSUPPORTED_AUTHORITY_STATE), or zero page evidence.
//
// Crash recovery: claim atomically (claimAny requeues expired leases first),
// heartbeat every 30s, expired leases (5min) reclaimable, stale IN_PROGRESS
// frontier resumable, DONE rows never re-fetched, completed runs never
// re-claimed. Network IO always happens outside transactions; each fetch
// persists observation + matches + frontier-DONE atomically afterwards.
//
// Fetching is sequential (concurrency 1, within the 2/origin bound): bounded,
// no unbounded fanout, no Redis. Structured logs carry ids and counters only;
// bodies and secrets are never logged.
import { Context, Duration, Effect, Fiber, Layer } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import { load } from "cheerio"
import {
  DiscoveryFrontierRepository,
  DiscoveryMatchRepository,
  DiscoveryObservationRepository,
  DiscoveryRunRepository,
  DiscoveryScopeRepository,
  FactRepository,
  ProductReadRepository,
  type DiscoveryFrontierRow,
  type DiscoveryMatchWrite,
  type DiscoveryRunRow,
  type RowDecodeError,
} from "@openrecord/db"
import { normalizeUrl, safeFetch, type HttpTransport, type SafeFetchEvidence } from "@openrecord/representation"
import {
  buildAuthoritySnapshot,
  buildFrontier,
  countCandidateGroups,
  DISCOVERY_BUDGETS_V1,
  DISCOVERY_USER_AGENT,
  effectiveCrawlDelayMs,
  fetchAndParseRobots,
  isAllowed,
  isInScope,
  matchPage,
  MATCHER_VERSION,
  parseSitemapBytes,
  shouldRefetchBody,
  type AuthoritySnapshotV1,
  type DiscoveredVia,
  type FactRowInput,
  type RobotsRules,
} from "@openrecord/discovery"

export const DISCOVERY_FETCH_TIMEOUT_MS = 8000
const HEARTBEAT_MS = 30_000
const MAX_LINKS_PER_PAGE = 1000
const MAX_FRONTIER_ROWS = 2000
const SITEMAP_FETCH_BYTES = DISCOVERY_BUDGETS_V1.sitemapDecompressedBytes

// ---------------------------------------------------------------------------
// Pure page-link extraction (link fallback only). Same cheerio reader family
// as matching; no JS execution. mailto/tel/javascript/data links and bare
// fragments are dropped before scope checks.
// ---------------------------------------------------------------------------

/** Extract resolved http(s) hrefs from anchor tags, order-stable, deduped. */
export const extractPageLinks = (html: string, baseUrl: string): string[] => {
  const $ = load(html)
  const out: string[] = []
  const seen = new Set<string>()
  $("a[href]").each((_i, el) => {
    const href = ($(el).attr("href") ?? "").trim()
    if (href === "" || href.startsWith("#")) return
    if (/^(mailto|tel|javascript|data):/i.test(href)) return
    try {
      const resolved = new URL(href, baseUrl).toString()
      const proto = new URL(resolved).protocol
      if (proto !== "http:" && proto !== "https:") return
      if (!seen.has(resolved)) {
        seen.add(resolved)
        out.push(resolved)
      }
    } catch {
      // Unresolvable href: ignored, never crawled.
    }
  })
  return out
}

// ---------------------------------------------------------------------------
// Runner service
// ---------------------------------------------------------------------------

export class DiscoveryRunner extends Context.Tag("DiscoveryRunner")<
  DiscoveryRunner,
  { readonly runOnce: () => Effect.Effect<boolean, SqlError | RowDecodeError> }
>() {}

interface CrawlCounters {
  attempted: number
  fetched: number
  notModified: number
  failed: number
  skippedRobots: number
  bytes: number
  /** Logical candidate groups (page + lineage), never raw match events. */
  candidates: number
}

export interface RobotsSeamFetchOpts {
  readonly byteCeiling: number
  readonly acceptedContentTypes: ReadonlyArray<string>
  readonly userAgent: string
  readonly timeoutMs: number
}

export interface RobotsSeamFetchResult {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly finalUrl: string
}

/**
 * Scope-bound robots fetcher adapter. Honors the caller's
 * acceptedContentTypes (robots V1: text/plain): an explicitly incompatible
 * type surfaces as UNSUPPORTED_CONTENT_TYPE and the caller fails closed
 * (UNAVAILABLE), never as empty allow-all rules. A missing Content-Type
 * retains pass-through behavior. Cross-origin redirects are never followed.
 */
export const makeRobotsFetcher = (scopeOrigin: string, transport?: HttpTransport): {
  readonly fetch: (url: string, opts: RobotsSeamFetchOpts) => Promise<RobotsSeamFetchResult>
} => ({
  fetch: async (url, opts) => {
    const ev = await safeFetch(url, {
      ...(transport !== undefined ? { transport } : {}),
      limits: { maxBytes: opts.byteCeiling, acceptedContentTypes: [...opts.acceptedContentTypes], allowMissingContentType: true, timeoutMs: opts.timeoutMs },
      userAgent: opts.userAgent,
      redirectPolicy: { maxRedirects: 5, allowCrossOrigin: false, scopeOrigin },
    })
    if (ev.failure === "OUT_OF_SCOPE_REDIRECT") throw new Error("robots fetch failed: OUT_OF_SCOPE_REDIRECT")
    if (ev.status === null) throw new Error(`robots fetch failed: ${ev.failure ?? "unknown"}`)
    if (ev.failure !== null && ev.failure !== "NETWORK_ERROR") {
      throw new Error(`robots fetch failed: ${ev.failure}`)
    }
    return { status: ev.status, headers: ev.headers, body: ev.body ?? new Uint8Array(0), finalUrl: ev.finalUrl }
  },
})

export const makeDiscoveryRunnerLive = () =>
  Layer.effect(
    DiscoveryRunner,
    Effect.gen(function*() {
      const runs = yield* DiscoveryRunRepository
      const scopes = yield* DiscoveryScopeRepository
      const frontier = yield* DiscoveryFrontierRepository
      const observations = yield* DiscoveryObservationRepository
      const matchesRepo = yield* DiscoveryMatchRepository
      const facts = yield* FactRepository
      const reads = yield* ProductReadRepository

      const log = (run: DiscoveryRunRow | null, msg: string, extra: Record<string, unknown> = {}) =>
        Effect.sync(() =>
          console.log(
            JSON.stringify({
              level: msg.startsWith("failed") ? "error" : "info",
              discovery_run_id: run?.id ?? null,
              business_id: run?.businessId ?? null,
              scope_id: run?.scopeId ?? null,
              ...extra,
              msg,
            }),
          ),
        )

      const failRun = (
        run: DiscoveryRunRow,
        failureClass: string,
        detail: string,
      ): Effect.Effect<true, SqlError | RowDecodeError> =>
        Effect.gen(function*() {
          yield* runs.markFinished(run.businessId, run.id, "FAILED", failureClass, detail.slice(0, 500))
          yield* log(run, `failed:${failureClass}`, { detail: detail.slice(0, 200) })
          return true as const
        })

      const fetchPageEvidence = (
        url: string,
        validators: { etag: string | null; last_modified: string | null } | null,
        scopeOrigin: string,
        isAllowedRedirect?: (target: string) => boolean,
      ): Promise<SafeFetchEvidence> =>
        safeFetch(url, {
          limits: {
            timeoutMs: DISCOVERY_FETCH_TIMEOUT_MS,
            maxRedirects: 5,
            maxBytes: DISCOVERY_BUDGETS_V1.pageBytes,
            acceptedContentTypes: ["text/html", "application/xhtml+xml"],
          },
          ...(validators !== null
            ? { validators: { etag: validators.etag, last_modified: validators.last_modified, origin: scopeOrigin } }
            : {}),
          redirectPolicy: {
            maxRedirects: 5,
            allowCrossOrigin: false,
            scopeOrigin,
            ...(isAllowedRedirect !== undefined ? { isAllowedRedirect } : {}),
          },
          userAgent: DISCOVERY_USER_AGENT,
        })

      // Freeze one snapshot per authority lineage. Malformed lineages land in
      // snapshot.unsupported and are skipped conservatively (never winners).
      const freezeAuthority = (businessId: string): Effect.Effect<AuthoritySnapshotV1, SqlError | RowDecodeError> =>
        Effect.gen(function*() {
          const all = yield* facts.listByBusiness(businessId)
          const byId = new Map<string, FactRowInput>()
          for (const f of all.filter((row) => row.status === "ACTIVE")) {
            // ProductRead failures are SqlError or RowDecodeError in practice
            // (typed unknown); a read failure aborts the run, never a silent
            // empty snapshot.
            const lineage = (yield* reads
              .factLineage(businessId, f.id)
              .pipe(Effect.mapError((e) => e as SqlError | RowDecodeError))) as Array<Record<string, unknown>>
            if (lineage.length === 0) continue
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
          return buildAuthoritySnapshot([...byId.values()])
        })

      const runOnce = (): Effect.Effect<boolean, SqlError | RowDecodeError> =>
        Effect.gen(function*() {
          const claimed = yield* runs.claimAny()
          if (!claimed) return false
          yield* log(claimed, "claimed", { attempt: claimed.attemptCount })
          const beat = yield* Effect.forkDaemon(
            Effect.forever(
              Effect.sleep(Duration.millis(HEARTBEAT_MS)).pipe(
                Effect.andThen(runs.heartbeat(claimed.businessId, claimed.id)),
              ),
            ).pipe(Effect.catchAllCause(() => Effect.void)),
          )
          return yield* scanRun(claimed).pipe(
            Effect.ensuring(Fiber.interrupt(beat)),
            // Caught deterministic runner error while the process is alive:
            // mark the run FAILED (typed RUNNER_ERROR) instead of silently
            // leaving it RUNNING. Guarded terminal transition; if the DB
            // itself is down the mark fails and lease recovery stays the
            // fallback. A real process crash never reaches here, so lease
            // recovery remains valid for that case.
            Effect.catchAll((e) =>
              Effect.gen(function*() {
                const detail = String(e).slice(0, 500)
                yield* runs
                  .markFinished(claimed.businessId, claimed.id, "FAILED", "RUNNER_ERROR", detail)
                  .pipe(Effect.catchAll(() => Effect.void))
                yield* Effect.sync(() => {
                  console.error(
                    JSON.stringify({
                      level: "error",
                      discovery_run_id: claimed.id,
                      business_id: claimed.businessId,
                      scope_id: claimed.scopeId,
                      error: detail,
                      msg: "runner error",
                    }),
                  )
                })
                return false as boolean
              }),
            ),
          )

          function scanRun(run: DiscoveryRunRow): Effect.Effect<boolean, SqlError | RowDecodeError> {
            return Effect.gen(function*() {
              const startedMs = Date.now()
              const scope = yield* scopes.getScoped(run.businessId, run.scopeId)
              if (!scope || !scope.enabled) {
                return yield* failRun(run, "INVALID_SCOPE", !scope ? "scope not found" : "scope disabled")
              }
              if (!isInScope(scope.rootUrl, { canonical_origin: scope.canonicalOrigin, path_prefix: scope.pathPrefix })) {
                return yield* failRun(run, "INVALID_SCOPE", "stored root_url outside scope")
              }
              const rootCanonical = normalizeUrl(scope.rootUrl)
              if (rootCanonical === null) {
                return yield* failRun(run, "INVALID_SCOPE", "stored root_url not canonicalizable")
              }
              const sc = scope

              // 1. Authority snapshot (frozen digest on the run).
              const snapshot = yield* freezeAuthority(run.businessId)
              if (snapshot.unsupported.length > 0) {
                yield* log(run, "unsupported lineages skipped", {
                  count: snapshot.unsupported.length,
                  reasons: snapshot.unsupported.map((u) => u.reason).sort().join(",").slice(0, 200),
                })
              }
              if (snapshot.lineages.length === 0) {
                const activeCount = (yield* facts.listByBusiness(run.businessId)).filter((f) => f.status === "ACTIVE").length
                if (activeCount > 0) {
                  return yield* failRun(run, "UNSUPPORTED_AUTHORITY_STATE", "no usable authority lineage")
                }
              }
              yield* runs.setAuthorityDigest(run.businessId, run.id, snapshot.digest)
              yield* log(run, "authority frozen", { lineages: snapshot.lineages.length, digest: snapshot.digest.slice(0, 16) })

              // Resume work left by a crashed attempt; DONE rows repeat never.
              yield* frontier.requeueStale(run.businessId, run.id)

              // 2. robots.txt via the shared fetcher (256KB cap), scope-bound
              // at both layers: the fetcher never follows a cross-origin
              // redirect, and the parser is told the scope origin so a
              // foreign policy can never apply to this scope.
              const robotsOutcome = yield* Effect.promise(async () => {
                try {
                  return await fetchAndParseRobots(sc.canonicalOrigin, makeRobotsFetcher(sc.canonicalOrigin), undefined, {
                    scopeOrigin: sc.canonicalOrigin,
                    allowCrossOrigin: false,
                  })
                } catch {
                  return { state: "UNAVAILABLE", detail: "NETWORK_ERROR" } as const
                }
              })
              if (robotsOutcome.state === "UNAVAILABLE") {
                yield* recordRobotsObservation(run, sc.id, "FAILED", "ROBOTS_UNAVAILABLE", null)
                return yield* failRun(run, "ROBOTS_UNAVAILABLE", robotsOutcome.detail)
              }
              if (robotsOutcome.state === "DENIED") {
                yield* recordRobotsObservation(run, sc.id, "FAILED", "ROBOTS_DENIED", 403)
                return yield* failRun(run, "ROBOTS_DENIED", "robots.txt denies access")
              }
              const rules: RobotsRules = robotsOutcome.state === "PARSED" ? robotsOutcome.rules : { disallows: [], crawlDelayMs: null, sitemaps: [] }
              if (robotsOutcome.state === "PARSED") {
                yield* recordRobotsObservation(run, sc.id, "FETCHED", null, 200)
              }
              const crawlDelay = effectiveCrawlDelayMs(rules)
              let lastFetchAt = 0
              const pace = (): Effect.Effect<void> =>
                Effect.promise(async () => {
                  const wait = lastFetchAt + crawlDelay - Date.now()
                  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
                  lastFetchAt = Date.now()
                })

              const robotsAllows = (canonicalUrl: string): boolean => {
                try {
                  const u = new URL(canonicalUrl)
                  return isAllowed(`${u.pathname}${u.search}`, rules)
                } catch {
                  return false
                }
              }

              function recordRobotsObservation(
                own: DiscoveryRunRow,
                scopeId: string,
                state: "FETCHED" | "FAILED",
                failure: string | null,
                status: number | null,
              ): Effect.Effect<void, SqlError | RowDecodeError> {
                return observations.insert({
                  businessId: own.businessId,
                  scopeId,
                  runId: own.id,
                  resourceKind: "ROBOTS",
                  requestedUrl: `${sc.canonicalOrigin}/robots.txt`,
                  canonicalUrl: `${sc.canonicalOrigin}/robots.txt`,
                  finalUrl: `${sc.canonicalOrigin}/robots.txt`,
                  discoveredVia: "ROOT",
                  startedAt: new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                  httpStatus: status,
                  contentType: state === "FETCHED" ? "text/plain" : null,
                  collectionState: state,
                  failure,
                }).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void))
              }

              // 3. Sitemap-first seeding (robots sitemaps -> /sitemap.xml ->
              // indexes -> urlsets; 20 docs / 10k entries caps, 5MB
              // decompressed PER DOCUMENT enforced inside parseSitemapBytes).
              const counters: CrawlCounters = { attempted: 0, fetched: 0, notModified: 0, failed: 0, skippedRobots: 0, bytes: 0, candidates: 0 }
              let budgetHit: string | null = null
              let orderCounter = 0
              const pad = (n: number): string => String(n).padStart(6, "0")
              const deadlineExceeded = (): boolean => Date.now() - startedMs > DISCOVERY_BUDGETS_V1.wallClockMs
              let sitemapTruncated = false

              const fetchSitemapDoc = (url: string, via: DiscoveredVia): Effect.Effect<{ urls: string[]; nested: string[] } | null, SqlError | RowDecodeError> =>
                Effect.gen(function*() {
                  yield* pace()
                  const ev = yield* Effect.promise(async () => {
                    try {
                      return await safeFetch(url, {
                        limits: { timeoutMs: DISCOVERY_FETCH_TIMEOUT_MS, maxRedirects: 5, maxBytes: SITEMAP_FETCH_BYTES, acceptedContentTypes: null },
                        redirectPolicy: { maxRedirects: 5, allowCrossOrigin: false, scopeOrigin: sc.canonicalOrigin },
                        userAgent: DISCOVERY_USER_AGENT,
                      })
                    } catch {
                      return null
                    }
                  })
                  if (ev === null || ev.failure !== null || ev.body === null) return null
                  // No runner-side gunzip: parseSitemapBytes is the single
                  // canonical gzip path (magic bytes decide; bounded output).
                  // The fetch byte cap bounds the compressed input.
                  const payload: Uint8Array = ev.body
                  try {
                    const parsed = parseSitemapBytes(payload, { url, origin: sc.canonicalOrigin })
                    if (parsed.truncated) sitemapTruncated = true
                    yield* observations.insert({
                      businessId: run.businessId,
                      scopeId: sc.id,
                      runId: run.id,
                      resourceKind: "SITEMAP",
                      requestedUrl: url,
                      canonicalUrl: normalizeUrl(url) ?? url,
                      finalUrl: ev.finalUrl,
                      discoveredVia: via,
                      startedAt: ev.startedAt,
                      completedAt: ev.completedAt,
                      httpStatus: ev.status,
                      contentType: ev.contentType,
                      bodyDigest: ev.bodyDigest,
                      bodyBytes: ev.bodyBytes,
                      collectionState: "FETCHED",
                    }).pipe(Effect.catchAll(() => Effect.succeed(null)))
                    return { urls: [...parsed.urls], nested: [...parsed.nested] }
                  } catch {
                    yield* observations.insert({
                      businessId: run.businessId,
                      scopeId: sc.id,
                      runId: run.id,
                      resourceKind: "SITEMAP",
                      requestedUrl: url,
                      canonicalUrl: normalizeUrl(url) ?? url,
                      finalUrl: ev.finalUrl,
                      discoveredVia: via,
                      startedAt: ev.startedAt,
                      completedAt: ev.completedAt,
                      httpStatus: ev.status,
                      contentType: ev.contentType,
                      bodyBytes: ev.bodyBytes,
                      collectionState: "FAILED",
                      failure: "UNSUPPORTED_CONTENT_TYPE",
                    }).pipe(Effect.catchAll(() => Effect.succeed(null)))
                    return null
                  }
                })

              const walkSitemaps = (): Effect.Effect<Array<{ url: string; via: DiscoveredVia }>, SqlError | RowDecodeError> =>
                Effect.gen(function*() {
                  const entryVias = new Map<string, DiscoveredVia>()
                  for (const s of rules.sitemaps) {
                    if (!entryVias.has(s)) entryVias.set(s, "ROBOTS_SITEMAP")
                  }
                  const defaultSitemap = `${sc.canonicalOrigin}/sitemap.xml`
                  if (!entryVias.has(defaultSitemap)) entryVias.set(defaultSitemap, "DEFAULT_SITEMAP")
                  const visited = new Set<string>()
                  const pageUrls: Array<{ url: string; via: DiscoveredVia }> = []
                  const seenPages = new Set<string>()
                  let docs = 0
                  const queue: Array<{ url: string; via: DiscoveredVia; nested: boolean }> = [...entryVias.entries()]
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                    .map(([url, via]) => ({ url, via, nested: false }))
                  while (queue.length > 0) {
                    if (docs >= DISCOVERY_BUDGETS_V1.sitemapDocs) {
                      sitemapTruncated = true
                      break
                    }
                    if (deadlineExceeded()) break
                    const next = queue.shift()
                    if (!next || visited.has(next.url)) continue
                    visited.add(next.url)
                    let sameOrigin = false
                    try {
                      sameOrigin = new URL(next.url).origin === sc.canonicalOrigin
                    } catch {
                      continue
                    }
                    if (!sameOrigin) continue // cross-origin sitemap: recorded, never fetched
                    const doc = yield* fetchSitemapDoc(next.url, next.nested ? "SITEMAP" : next.via)
                    if (doc === null) continue
                    docs += 1
                    for (const u of doc.urls) {
                      if (seenPages.has(u)) continue
                      seenPages.add(u)
                      if (pageUrls.length >= DISCOVERY_BUDGETS_V1.sitemapEntries) {
                        sitemapTruncated = true
                        break
                      }
                      pageUrls.push({ url: u, via: next.nested ? "SITEMAP" : next.via })
                    }
                    for (const n of [...new Set(doc.nested)].sort()) {
                      if (!visited.has(n)) queue.push({ url: n, via: "SITEMAP", nested: true })
                    }
                    queue.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
                  }
                  return pageUrls
                })

              const sitemapUrls = yield* walkSitemaps()

              // Deterministic frontier: scope + query gating, dedupe, depth,
              // soft-budget cap. Robots filtering marks SKIPPED (never fetched).
              const frontierScope = { canonical_origin: sc.canonicalOrigin, path_prefix: sc.pathPrefix }
              const seedCandidates = [
                { url: sc.rootUrl, discoveredVia: "ROOT" as DiscoveredVia, parentUrl: null as string | null, depth: 0 },
                ...sitemapUrls.map((u) => ({ url: u.url, discoveredVia: u.via, parentUrl: null as string | null, depth: 0 })),
              ]
              const built = buildFrontier({ scope: frontierScope, candidates: seedCandidates })
              const useLinkFallback = built.entries.length === 0
              const seedEntries = useLinkFallback
                ? [{ url: sc.rootUrl, discoveredVia: "ROOT" as DiscoveredVia, parentUrl: null as string | null, depth: 0 }]
                : built.entries.map((e) => ({ url: e.requestedUrl, discoveredVia: e.discoveredVia, parentUrl: e.parentUrl, depth: e.depth }))
              const mode = useLinkFallback ? "link" : "sitemap"
              if (useLinkFallback) {
                yield* log(run, "sitemap empty, link fallback", {})
              }

              const toSeed = seedEntries.map((e) => {
                const canonical = normalizeUrl(e.url) ?? e.url
                const key = pad(orderCounter)
                orderCounter += 1
                return { canonicalUrl: canonical, requestedUrl: e.url, discoveredVia: e.discoveredVia, parentUrl: e.parentUrl, depth: e.depth, orderKey: key }
              })
              // Robots-disallowed seeds are recorded, never fetched: they go
              // straight to SKIPPED, only allowed URLs enter as PENDING.
              const allowedSeeds = toSeed.filter((e) => robotsAllows(e.canonicalUrl))
              const deniedSeeds = toSeed.filter((e) => !robotsAllows(e.canonicalUrl))
              yield* frontier.enqueueMany({ businessId: run.businessId, runId: run.id, entries: allowedSeeds })
              if (deniedSeeds.length > 0) {
                yield* frontier.insertSkipped({
                  businessId: run.businessId,
                  runId: run.id,
                  entries: deniedSeeds.map((e) => ({ ...e, reason: "ROBOTS_DISALLOWED" })),
                })
                counters.skippedRobots += deniedSeeds.length
                yield* runs.incrementCounters(run.businessId, run.id, { pagesSkippedRobots: deniedSeeds.length })
              }
              // Informative skips are recorded (query links, robots-denied);
              // scope noise, duplicates, and budget overflow stay in the log.
              const notableSkips = built.skipped.filter((s) => s.reason === "QUERY_LINK_SKIPPED" || s.reason === "ROBOTS_DISALLOWED")
              if (notableSkips.length > 0) {
                yield* frontier.insertSkipped({
                  businessId: run.businessId,
                  runId: run.id,
                  entries: notableSkips.map((s) => {
                    const key = pad(orderCounter)
                    orderCounter += 1
                    return {
                      canonicalUrl: normalizeUrl(s.url) ?? s.url,
                      requestedUrl: s.url,
                      discoveredVia: "LINK",
                      parentUrl: null as string | null,
                      depth: 0,
                      orderKey: key,
                      reason: s.reason,
                    }
                  }),
                })
              }
              if (built.partial || sitemapTruncated) budgetHit = "BUDGET_EXHAUSTED"

              // 4. Bounded crawl. Sequential: concurrency 1, within 2/origin.
              let enqueuedTotal = orderCounter
              for (;;) {
                if (deadlineExceeded()) {
                  budgetHit = "BUDGET_EXHAUSTED"
                  break
                }
                if (counters.attempted >= DISCOVERY_BUDGETS_V1.hardPageCap) {
                  budgetHit = "BUDGET_EXHAUSTED"
                  break
                }
                if (counters.attempted >= DISCOVERY_BUDGETS_V1.maxPages) {
                  budgetHit = "BUDGET_EXHAUSTED"
                  break
                }
                const item: DiscoveryFrontierRow | null = yield* frontier.claimNext(run.businessId, run.id)
                if (!item) break
                if (!robotsAllows(item.canonicalUrl)) {
                  yield* frontier.markSkipped(run.businessId, item.id, "ROBOTS_DISALLOWED")
                  counters.skippedRobots += 1
                  yield* runs.incrementCounters(run.businessId, run.id, { pagesSkippedRobots: 1 })
                  continue
                }
                yield* pace()
                const prior = yield* observations.latestValidators(run.businessId, sc.id, item.canonicalUrl)
                const reuseAllowed =
                  prior !== null &&
                  !shouldRefetchBody({
                    authoritySame: prior.authorityDigest === snapshot.digest,
                    matcherSame: prior.matcherVersion === MATCHER_VERSION,
                    hasBody: prior.etag !== null || prior.lastModified !== null,
                  })
                const ev = yield* Effect.promise(async () => {
                  try {
                    // Path-prefix scope applies BEFORE the redirect fetch:
                    // a target outside the configured subtree is never
                    // requested. Origin-level resources (robots/sitemaps)
                    // keep origin rules; only PAGE content is prefix-gated.
                    return await fetchPageEvidence(
                      item.requestedUrl,
                      reuseAllowed && prior !== null ? { etag: prior.etag, last_modified: prior.lastModified } : null,
                      sc.canonicalOrigin,
                      (target) => isInScope(target, frontierScope),
                    )
                  } catch {
                    return null
                  }
                })
                counters.attempted += 1
                if (ev === null) {
                  yield* persistFailedPage(item, "NETWORK_ERROR", null)
                  continue
                }
                if (ev.failure === "OUT_OF_SCOPE_REDIRECT") {
                  yield* frontier.markSkipped(run.businessId, item.id, "OUT_OF_SCOPE_REDIRECT")
                  continue
                }
                if (ev.failure !== null) {
                  yield* persistFailedPage(item, mapPageFailure(ev.failure), ev)
                  continue
                }
                // Same-origin redirect landing outside the prefix: in-scope
                // check fails closed without matching the body.
                const finalCanonical = normalizeUrl(ev.finalUrl)
                if (finalCanonical === null || !isInScope(finalCanonical, frontierScope)) {
                  yield* frontier.markSkipped(run.businessId, item.id, "OUT_OF_SCOPE_REDIRECT")
                  continue
                }
                if (!robotsAllows(finalCanonical)) {
                  yield* persistDeniedPage(item, ev)
                  continue
                }
                if (ev.notModified) {
                  // Compatible 304: carry prior effective candidate evidence
                  // into this run with explicit reuse provenance. Valid ONLY
                  // under identical authority digest + matcher version (the
                  // repo query enforces it); otherwise no candidate is
                  // created. Chained 304s reference the immediate prior, so
                  // ancestry stays traceable hop by hop.
                  const priorMatches = yield* matchesRepo.latestEffectiveMatches({
                    businessId: run.businessId,
                    scopeId: sc.id,
                    canonicalUrl: item.canonicalUrl,
                    authorityDigest: snapshot.digest,
                    matcherVersion: MATCHER_VERSION,
                  })
                  const reuseWrites: Omit<DiscoveryMatchWrite, "pageObservationId">[] = priorMatches.map((p) => ({
                    lineageRootFactId: p.lineageRootFactId,
                    matchedFactId: p.matchedFactId,
                    matchedFactVersion: p.matchedFactVersion,
                    matchedValue: p.matchedValue,
                    matchSurface: p.matchSurface as "JSON_LD" | "META" | "VISIBLE_TEXT",
                    evidenceLocator: p.evidenceLocator,
                    evidenceSnippet: p.evidenceSnippet,
                    relationAtScan: p.relationAtScan as "CURRENT_VALUE" | "HISTORICAL_VALUE",
                    matcherVersion: MATCHER_VERSION,
                    reusedFromMatchId: p.id,
                  }))
                  const reusedGroups = countCandidateGroups(
                    reuseWrites.map((m) => ({ pageKey: item.canonicalUrl, lineageRootFactId: m.lineageRootFactId })),
                  )
                  yield* frontier.persistPageFetch({
                    businessId: run.businessId,
                    frontierId: item.id,
                    observation: {
                      scopeId: sc.id,
                      runId: run.id,
                      resourceKind: "PAGE",
                      requestedUrl: item.requestedUrl,
                      canonicalUrl: item.canonicalUrl,
                      finalUrl: ev.finalUrl,
                      discoveredVia: item.discoveredVia,
                      parentUrl: item.parentUrl,
                      depth: item.depth,
                      startedAt: ev.startedAt,
                      completedAt: ev.completedAt,
                      httpStatus: ev.status,
                      etag: ev.etag,
                      lastModified: ev.lastModified,
                      collectionState: "NOT_MODIFIED",
                    },
                    matches: reuseWrites,
                  })
                  counters.notModified += 1
                  counters.candidates += reusedGroups
                  yield* runs.incrementCounters(run.businessId, run.id, { pagesNotModified: 1, candidatesFound: reusedGroups })
                  continue
                }
                // Fresh body: match against the frozen snapshot (never live truth).
                const html = ev.body === null ? "" : Buffer.from(ev.body).toString("utf8")
                const matched = matchHtml(html)
                if (matched === null) {
                  yield* persistFailedPage(item, "NETWORK_ERROR", ev)
                  continue
                }
                yield* frontier.persistPageFetch({
                  businessId: run.businessId,
                  frontierId: item.id,
                  observation: {
                    scopeId: sc.id,
                    runId: run.id,
                    resourceKind: "PAGE",
                    requestedUrl: item.requestedUrl,
                    canonicalUrl: item.canonicalUrl,
                    finalUrl: ev.finalUrl,
                    discoveredVia: item.discoveredVia,
                    parentUrl: item.parentUrl,
                    depth: item.depth,
                    startedAt: ev.startedAt,
                    completedAt: ev.completedAt,
                    httpStatus: ev.status,
                    contentType: ev.contentType,
                    etag: ev.etag,
                    lastModified: ev.lastModified,
                    bodyDigest: ev.bodyDigest,
                    bodyBytes: ev.bodyBytes,
                    collectionState: "FETCHED",
                  },
                  matches: matched,
                })
                counters.fetched += 1
                counters.bytes += ev.bodyBytes
                const pageGroups = countCandidateGroups(
                  matched.map((m) => ({ pageKey: item.canonicalUrl, lineageRootFactId: m.lineageRootFactId })),
                )
                counters.candidates += pageGroups
                yield* runs.incrementCounters(run.businessId, run.id, {
                  pagesFetched: 1,
                  bytesDownloaded: ev.bodyBytes,
                  candidatesFound: pageGroups,
                })
                // Link fallback expansion: depth-bounded, scope/query gated
                // via buildFrontier, deduped by the DB unique identity.
                if (mode === "link" && item.depth < DISCOVERY_BUDGETS_V1.linkDepth && enqueuedTotal < MAX_FRONTIER_ROWS) {
                  const links = extractPageLinks(html, ev.finalUrl).slice(0, MAX_LINKS_PER_PAGE)
                  if (links.length > 0) {
                    const grown = buildFrontier({
                      scope: frontierScope,
                      candidates: links.map((u) => ({
                        url: u,
                        discoveredVia: "LINK" as DiscoveredVia,
                        parentUrl: item.canonicalUrl,
                        depth: item.depth + 1,
                      })),
                    })
                    const fresh = grown.entries.map((e) => {
                      const key = pad(orderCounter)
                      orderCounter += 1
                      return {
                        canonicalUrl: e.canonicalUrl,
                        requestedUrl: e.requestedUrl,
                        discoveredVia: e.discoveredVia,
                        parentUrl: e.parentUrl,
                        depth: e.depth,
                        orderKey: key,
                      }
                    })
                    if (fresh.length > 0) {
                      enqueuedTotal += yield* frontier.enqueueMany({ businessId: run.businessId, runId: run.id, entries: fresh })
                    }
                    const linkSkips = grown.skipped.filter((s) => s.reason === "QUERY_LINK_SKIPPED")
                    if (linkSkips.length > 0 && enqueuedTotal < MAX_FRONTIER_ROWS) {
                      enqueuedTotal += yield* frontier.insertSkipped({
                        businessId: run.businessId,
                        runId: run.id,
                        entries: linkSkips.map((s) => {
                          const key = pad(orderCounter)
                          orderCounter += 1
                          return {
                            canonicalUrl: normalizeUrl(s.url) ?? s.url,
                            requestedUrl: s.url,
                            discoveredVia: "LINK",
                            parentUrl: item.canonicalUrl,
                            depth: item.depth + 1,
                            orderKey: key,
                            reason: s.reason,
                          }
                        }),
                      })
                    }
                  }
                }
              }

              function persistFailedPage(
                item: DiscoveryFrontierRow,
                failure: string,
                ev: SafeFetchEvidence | null,
              ): Effect.Effect<void, SqlError | RowDecodeError> {
                return Effect.gen(function*() {
                  yield* frontier.persistPageFetch({
                    businessId: run.businessId,
                    frontierId: item.id,
                    observation: {
                      scopeId: sc.id,
                      runId: run.id,
                      resourceKind: "PAGE",
                      requestedUrl: item.requestedUrl,
                      canonicalUrl: item.canonicalUrl,
                      finalUrl: ev?.finalUrl ?? item.requestedUrl,
                      discoveredVia: item.discoveredVia,
                      parentUrl: item.parentUrl,
                      depth: item.depth,
                      startedAt: ev?.startedAt ?? new Date().toISOString(),
                      completedAt: ev?.completedAt ?? new Date().toISOString(),
                      httpStatus: ev?.status ?? null,
                      contentType: ev?.contentType ?? null,
                      bodyBytes: ev?.bodyBytes ?? 0,
                      collectionState: "FAILED",
                      failure,
                    },
                    matches: [],
                  })
                  counters.failed += 1
                  yield* runs.incrementCounters(run.businessId, run.id, { pagesFailed: 1 })
                })
              }

              function persistDeniedPage(item: DiscoveryFrontierRow, ev: SafeFetchEvidence): Effect.Effect<void, SqlError | RowDecodeError> {
                return Effect.gen(function*() {
                  // Fetched but robots-disallowed at the final URL: recorded
                  // as denied, never matched.
                  yield* frontier.persistPageFetch({
                    businessId: run.businessId,
                    frontierId: item.id,
                    observation: {
                      scopeId: sc.id,
                      runId: run.id,
                      resourceKind: "PAGE",
                      requestedUrl: item.requestedUrl,
                      canonicalUrl: item.canonicalUrl,
                      finalUrl: ev.finalUrl,
                      discoveredVia: item.discoveredVia,
                      parentUrl: item.parentUrl,
                      depth: item.depth,
                      startedAt: ev.startedAt,
                      completedAt: ev.completedAt,
                      httpStatus: ev.status,
                      contentType: ev.contentType,
                      etag: ev.etag,
                      lastModified: ev.lastModified,
                      bodyBytes: ev.bodyBytes,
                      collectionState: "FAILED",
                      failure: "ROBOTS_DENIED",
                    },
                    matches: [],
                  })
                  counters.skippedRobots += 1
                  yield* runs.incrementCounters(run.businessId, run.id, { pagesSkippedRobots: 1 })
                })
              }

              function matchHtml(html: string): Array<{
                lineageRootFactId: string
                matchedFactId: string
                matchedFactVersion: number
                matchedValue: string
                matchSurface: "JSON_LD" | "META" | "VISIBLE_TEXT"
                evidenceLocator: string
                evidenceSnippet: string
                relationAtScan: "CURRENT_VALUE" | "HISTORICAL_VALUE"
                matcherVersion: string
              }> | null {
                try {
                  const seen = new Set<string>()
                  const out: Array<{
                    lineageRootFactId: string
                    matchedFactId: string
                    matchedFactVersion: number
                    matchedValue: string
                    matchSurface: "JSON_LD" | "META" | "VISIBLE_TEXT"
                    evidenceLocator: string
                    evidenceSnippet: string
                    relationAtScan: "CURRENT_VALUE" | "HISTORICAL_VALUE"
                    matcherVersion: string
                  }> = []
                  for (const e of matchPage(html, { lineages: snapshot.lineages })) {
                    const key = `${e.lineageRoot} ${e.matchedFact} ${e.surface} ${e.locator}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    out.push({
                      lineageRootFactId: e.lineageRoot,
                      matchedFactId: e.matchedFact,
                      matchedFactVersion: e.matchedVersion,
                      matchedValue: e.matchedValue,
                      matchSurface: e.surface,
                      evidenceLocator: e.locator,
                      evidenceSnippet: e.snippet,
                      relationAtScan: e.relation,
                      matcherVersion: MATCHER_VERSION,
                    })
                  }
                  return out
                } catch {
                  return null
                }
              }

              // 5. Terminal state per exact semantics.
              const elapsedMs = Date.now() - startedMs
              const pageEvidence = counters.fetched + counters.notModified
              if (budgetHit !== null || deadlineExceeded()) {
                yield* runs.markFinished(run.businessId, run.id, "PARTIAL", "BUDGET_EXHAUSTED", "bounded scan stopped: budget or deadline")
                yield* log(run, "partial:budget", {
                  pages_fetched: counters.fetched,
                  bytes: counters.bytes,
                  candidates: counters.candidates,
                  elapsed_ms: elapsedMs,
                })
                return true
              }
              if (pageEvidence === 0 && counters.failed > 0) {
                return yield* failRun(run, "FETCH_FAILED", `${counters.failed} pages failed without evidence`)
              }
              if (counters.failed > 0) {
                yield* runs.markFinished(run.businessId, run.id, "PARTIAL", "PAGE_FAILURES", `${counters.failed} pages failed with evidence`)
                yield* log(run, "partial:failures", {
                  pages_fetched: counters.fetched,
                  bytes: counters.bytes,
                  candidates: counters.candidates,
                  elapsed_ms: elapsedMs,
                })
                return true
              }
              yield* runs.markFinished(run.businessId, run.id, "SUCCEEDED", null, null)
              yield* log(run, "succeeded", {
                pages_fetched: counters.fetched,
                bytes: counters.bytes,
                candidates: counters.candidates,
                elapsed_ms: elapsedMs,
              })
              return true
            })
          }
        })
      return { runOnce }
    }),
  )

const mapPageFailure = (failure: NonNullable<SafeFetchEvidence["failure"]>): string => {
  switch (failure) {
    case "TIMEOUT":
      return "TIMEOUT"
    case "REDIRECT_LIMIT":
      return "REDIRECT_LIMIT"
    case "RESPONSE_TOO_LARGE":
      return "RESPONSE_TOO_LARGE"
    case "UNSUPPORTED_CONTENT_TYPE":
      return "UNSUPPORTED_CONTENT_TYPE"
    case "SECURITY_REJECTED":
      return "SECURITY_REJECTED"
    case "INVALID_URL":
      return "INVALID_URL"
    default:
      return "NETWORK_ERROR"
  }
}

export const DiscoveryRunnerLive = makeDiscoveryRunnerLive()
