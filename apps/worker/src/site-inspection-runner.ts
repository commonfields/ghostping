// SiteInspectionRunner: claims one QUEUED site inspection run, inspects the
// target through the shared safeFetch (SSRF-safe, bounded), derives concrete
// findings with evidence binding, proposes fixes, and reconciles pending
// verifications against live re-observation.
//
// Terminal semantics:
// - SUCCEEDED = every URL inspected with evidence.
// - PARTIALLY_SUCCEEDED = some URLs failed but findings persist with gaps visible.
// - FAILED = invalid scope/target blocked, or zero page evidence.
//
// Crash recovery mirrors DiscoveryRunner: atomic claimAny with lease
// reclaim, heartbeat every 30s, DONE-equivalent via observations (append-only,
// never re-fetched within a run). Network IO happens outside transactions;
// each page persists observation + findings atomically afterwards (separate
// statements; observations are append-only so partial writes stay honest).
//
// Never claims "No problems found" when the crawl failed: zero-evidence runs
// fail closed, and partial runs surface urls_failed explicitly.
import { Context, Duration, Effect, Fiber, Layer } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import {
  SiteFindingRepository,
  SiteFixProposalRepository,
  SiteGscRepository,
  SiteMutationRepository,
  SiteOperatorEventRepository,
  SitePageObservationRepository,
  SiteRunRepository,
  SiteTargetRepository,
  SiteVerificationRepository,
  type RowDecodeError,
  type SiteRunRow,
} from "@ghostping/db"
import { safeFetch, type HttpTransport } from "@ghostping/representation"
import { isInScope } from "@ghostping/discovery"
import {
  INSPECTOR_VERSION,
  SITE_INSPECTION_BUDGETS,
  type DerivedFinding,
} from "@ghostping/site-operator"
import {
  classifyIndexability,
  derivePageFindings,
  extractPageEvidence,
} from "@ghostping/site-operator"
import { parseRobotsTxt, isUrlAllowedByRobots } from "@ghostping/site-operator"
import { parseSitemapXml } from "@ghostping/site-operator"
import { buildLinkGraph } from "@ghostping/site-operator"
import { evidenceDigest, findingIdentityKey, normalizeFindingUrl } from "@ghostping/site-operator"
import { proposeFix } from "@ghostping/site-operator"

export const SITE_FETCH_TIMEOUT_MS = SITE_INSPECTION_BUDGETS.timeoutMs

export class SiteInspectionRunner extends Context.Tag("SiteInspectionRunner")<
  SiteInspectionRunner,
  { readonly runOnce: () => Effect.Effect<boolean, SqlError | RowDecodeError> }
>() {}

export interface SiteRunnerOptions {
  readonly transport?: HttpTransport
}

export const normalizeUrl = (raw: string): string | null => {
  try {
    const u = new URL(raw)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    u.hash = ""
    return u.toString()
  } catch {
    return null
  }
}

const mapFetchFailure = (failure: string | null): string => {
  switch (failure) {
    case "TIMEOUT":
      return "CONNECT_TIMEOUT"
    case "REDIRECT_LIMIT":
      return "HTTP_FAILURE"
    case "RESPONSE_TOO_LARGE":
      return "HTTP_FAILURE"
    case "SECURITY_REJECTED":
      return "TARGET_BLOCKED"
    case "INVALID_URL":
      return "HTTP_FAILURE"
    default:
      return "HTTP_FAILURE"
  }
}

export const makeSiteInspectionRunnerLive = (opts: SiteRunnerOptions = {}) =>
  Layer.effect(
    SiteInspectionRunner,
    Effect.gen(function*() {
      const runs = yield* SiteRunRepository
      const targets = yield* SiteTargetRepository
      const observations = yield* SitePageObservationRepository
      const findings = yield* SiteFindingRepository
      const proposals = yield* SiteFixProposalRepository
      const mutations = yield* SiteMutationRepository
      const verifications = yield* SiteVerificationRepository
      const events = yield* SiteOperatorEventRepository
      void mutations
      void verifications
      void SiteGscRepository

      const transport = opts.transport

      const log = (run: SiteRunRow | null, msg: string, extra: Record<string, unknown> = {}) =>
        Effect.sync(() =>
          console.log(JSON.stringify({ level: msg.startsWith("failed") ? "error" : "info", site_run_id: run?.id ?? null, ...extra, msg })),
        )

      const failRun = (run: SiteRunRow, failureClass: string, detail: string) =>
        Effect.gen(function*() {
          yield* runs.markFinished(run.businessId, run.id, "FAILED", failureClass, detail.slice(0, 500))
          yield* events.append({ businessId: run.businessId, runId: run.id, kind: "RUN_FAILED", payload: { failureClass, detail: detail.slice(0, 200) } }).pipe(Effect.ignore)
          yield* log(run, `failed:${failureClass}`, { detail: detail.slice(0, 200) })
          return true as const
        })

      const fetchOne = (url: string, scopeOrigin: string, isAllowedRedirect?: (t: string) => boolean) =>
        safeFetch(url, {
          ...(transport ? { transport } : {}),
          limits: { timeoutMs: SITE_FETCH_TIMEOUT_MS, maxRedirects: SITE_INSPECTION_BUDGETS.maxRedirects, maxBytes: SITE_INSPECTION_BUDGETS.maxBytes, acceptedContentTypes: ["text/html", "application/xhtml+xml"] },
          redirectPolicy: { maxRedirects: SITE_INSPECTION_BUDGETS.maxRedirects, allowCrossOrigin: true, scopeOrigin, ...(isAllowedRedirect ? { isAllowedRedirect } : {}) },
          userAgent: "Ghostping-SiteInspector/1",
        })

      const runOnce = (): Effect.Effect<boolean, SqlError | RowDecodeError> =>
        Effect.gen(function*() {
          const claimed = yield* runs.claimAny()
          if (!claimed) return false
          yield* log(claimed, "site run claimed")
          yield* events.append({ businessId: claimed.businessId, runId: claimed.id, kind: "RUN_STARTED", payload: { siteTargetId: claimed.siteTargetId } }).pipe(Effect.ignore)
          const beat = yield* Effect.forkDaemon(
            Effect.forever(Effect.sleep(Duration.millis(30_000)).pipe(Effect.andThen(runs.heartbeat(claimed.businessId, claimed.id)))).pipe(Effect.catchAllCause(() => Effect.void)),
          )
          return yield* scanRun(claimed).pipe(
            Effect.ensuring(Fiber.interrupt(beat)),
            Effect.catchAll((e) =>
              Effect.gen(function*() {
                const detail = String(e).slice(0, 500)
                yield* runs.markFinished(claimed.businessId, claimed.id, "FAILED", "RUNNER_ERROR", detail).pipe(Effect.catchAll(() => Effect.void))
                return false as boolean
              }),
            ),
          )

          function scanRun(run: SiteRunRow): Effect.Effect<boolean, SqlError | RowDecodeError> {
            return Effect.gen(function*() {
              const startedMs = Date.now()
              const target = yield* targets.getScoped(run.businessId, run.siteTargetId)
              if (!target || !target.enabled) {
                return yield* failRun(run, "INVALID_SCOPE", !target ? "site target not found" : "site target disabled")
              }
              const origin = target.canonicalOrigin
              const scope = { canonical_origin: origin, path_prefix: target.pathPrefix }
              if (!isInScope(target.rootUrl, scope)) {
                return yield* failRun(run, "INVALID_SCOPE", "stored root_url outside scope")
              }
              const rootCanonical = normalizeUrl(target.rootUrl)
              if (!rootCanonical) return yield* failRun(run, "INVALID_SCOPE", "stored root_url not canonicalizable")

              // 1. robots.txt (256KB cap, scope-bound, never cross-origin).
              let rules: { disallows: ReadonlyArray<string>; allows: ReadonlyArray<string>; sitemaps: ReadonlyArray<string>; crawlDelayMs: number | null } = { disallows: [], allows: [], sitemaps: [], crawlDelayMs: null }
              let robotsText: string | null = null
              try {
                const ev = yield* Effect.promise(() =>
                  safeFetch(`${origin}/robots.txt`, {
                    ...(transport ? { transport } : {}),
                    limits: { timeoutMs: SITE_FETCH_TIMEOUT_MS, maxRedirects: 5, maxBytes: 256 * 1024, acceptedContentTypes: null },
                    redirectPolicy: { maxRedirects: 5, allowCrossOrigin: false, scopeOrigin: origin },
                    userAgent: "Ghostping-SiteInspector/1",
                  }),
                )
                if (ev.failure === null && ev.body) {
                  robotsText = Buffer.from(ev.body).toString("utf8")
                  rules = parseRobotsTxt(robotsText)
                }
              } catch {
                // robots unavailable: proceed as allow-all, provenance records it.
              }

              // 2. Sitemap discovery: robots entries + /sitemap.xml, bounded walk.
              const sitemapProvenance = new Map<string, string>() // url -> chain label
              const sitemapUrls: string[] = []
              {
                const seeds = [...new Set([...rules.sitemaps, `${origin}/sitemap.xml`])]
                const visited = new Set<string>()
                const queue: Array<{ url: string; depth: number; via: string }> = seeds.map((u) => ({ url: u, depth: 0, via: "ROOT" }))
                let docs = 0
                while (queue.length > 0 && docs < SITE_INSPECTION_BUDGETS.sitemapDocs && Date.now() - startedMs < SITE_INSPECTION_BUDGETS.wallClockMs) {
                  const next = queue.shift()
                  if (!next) continue
                  if (visited.has(next.url)) continue
                  visited.add(next.url)
                  try {
                    if (new URL(next.url).origin !== origin) continue
                  } catch {
                    continue
                  }
                  const ev = yield* Effect.promise(() =>
                    safeFetch(next.url, {
                      ...(transport ? { transport } : {}),
                      limits: { timeoutMs: SITE_FETCH_TIMEOUT_MS, maxRedirects: 5, maxBytes: 5 * 1024 * 1024, acceptedContentTypes: null },
                      redirectPolicy: { maxRedirects: 5, allowCrossOrigin: false, scopeOrigin: origin },
                      userAgent: "Ghostping-SiteInspector/1",
                    }),
                  ).pipe(Effect.catchAll(() => Effect.succeed(null)))
                  if (!ev || ev.failure !== null || !ev.body) continue
                  try {
                    const parsed = parseSitemapXml(Buffer.from(ev.body).toString("utf8"), { origin })
                    docs += 1
                    for (const u of parsed.urls) {
                      if (sitemapUrls.length >= SITE_INSPECTION_BUDGETS.sitemapEntries) break
                      if (!sitemapUrls.includes(u)) {
                        sitemapUrls.push(u)
                        sitemapProvenance.set(u, next.depth === 0 ? robotsText?.includes(next.url) ? `robots.txt → ${next.url}` : `${next.url}` : `robots.txt → … → ${next.url}`)
                      }
                    }
                    if (next.depth < SITE_INSPECTION_BUDGETS.sitemapMaxDepth) {
                      for (const n of parsed.nested) queue.push({ url: n, depth: next.depth + 1, via: next.url })
                    }
                  } catch {
                    // Malformed sitemap: recorded below as SITEMAP_INVALID.
                    yield* persistSitemapInvalidFinding(run, target.id, next.url)
                  }
                }
              }

              // 3. URL list: root + same-origin in-scope sitemap URLs, capped.
              const candidates = [target.rootUrl, ...sitemapUrls]
                .map((u) => normalizeUrl(u) ?? u)
                .filter((u, i, arr) => arr.indexOf(u) === i)
                .filter((u) => {
                  try {
                    if (new URL(u).origin !== origin) return false
                  } catch {
                    return false
                  }
                  return isInScope(u, scope)
                })
                .slice(0, SITE_INSPECTION_BUDGETS.maxUrls)

              let inspected = 0
              let failed = 0
              let findingsCount = 0
              const pageLinks = new Map<string, string[]>()
              const statuses = new Map<string, number | null>()
              const observedByUrl = new Map<string, { indexability: string; findings: DerivedFinding[] }>()

              for (const candidate of candidates) {
                if (Date.now() - startedMs > SITE_INSPECTION_BUDGETS.wallClockMs) break
                const allowed = isUrlAllowedByRobots(candidate, rules)
                const ev = yield* Effect.promise(() => fetchOne(candidate, origin, (t) => isInScope(t, scope))).pipe(
                  Effect.catchAll(() => Effect.succeed(null)),
                )
                if (!ev) {
                  failed += 1
                  yield* runs.incrementCounters(run.businessId, run.id, { urlsFailed: 1 })
                  continue
                }
                yield* events.append({ businessId: run.businessId, runId: run.id, kind: "URL_INSPECTED", payload: { url: candidate, status: ev.status } }).pipe(Effect.ignore)
                if (ev.failure === "OUT_OF_SCOPE_REDIRECT") {
                  failed += 1
                  yield* runs.incrementCounters(run.businessId, run.id, { urlsFailed: 1 })
                  continue
                }
                if (ev.failure !== null || ev.body === null) {
                  // Failed fetch: persist FAILED observation, never a finding
                  // masquerading as success.
                  const failureClass = ev.failure === "SECURITY_REJECTED" ? "TARGET_BLOCKED" : mapFetchFailure(ev.failure)
                  if (ev.failure === "REDIRECT_LIMIT") {
                    // Redirect loops still produce a concrete finding.
                    const loopFindings = derivePageFindings(
                      extractPageEvidence({ url: candidate, finalUrl: ev.finalUrl, status: ev.status, contentType: ev.contentType, redirectChain: [...ev.redirectChain], headers: ev.headers, html: null, failure: "REDIRECT_LIMIT" }),
                      { robotsDisallowed: false },
                    )
                    for (const f of loopFindings) {
                      const created = yield* persistFinding(run, target.id, null, candidate, candidate, f, ev)
                      if (created) findingsCount += 1
                    }
                    inspected += 1
                    yield* runs.incrementCounters(run.businessId, run.id, { urlsInspected: 1, findingsProduced: loopFindings.length })
                    continue
                  }
                  yield* observations.insert({
                    businessId: run.businessId,
                    runId: run.id,
                    siteTargetId: target.id,
                    url: candidate,
                    canonicalUrl: normalizeUrl(candidate) ?? candidate,
                    finalUrl: ev.finalUrl,
                    startedAt: ev.startedAt,
                    completedAt: ev.completedAt,
                    httpStatus: ev.status,
                    contentType: ev.contentType,
                    redirectChain: [...ev.redirectChain],
                    headers: ev.headers,
                    bodyBytes: 0,
                    indexability: "UNKNOWN",
                    evidence: { failure: ev.failure, failureClass },
                    collectionState: "FAILED",
                    failure: failureClass,
                  }).pipe(Effect.catchAll(() => Effect.succeed(null)))
                  failed += 1
                  yield* runs.incrementCounters(run.businessId, run.id, { urlsFailed: 1 })
                  continue
                }
                const html = Buffer.from(ev.body).toString("utf8")
                const page = extractPageEvidence({
                  url: candidate,
                  finalUrl: ev.finalUrl,
                  status: ev.status,
                  contentType: ev.contentType,
                  redirectChain: [...ev.redirectChain],
                  headers: ev.headers,
                  html,
                  failure: null,
                  robotsDisallowed: !allowed,
                })
                const indexability = classifyIndexability(page, !allowed)
                const pageFindings = derivePageFindings(page, { robotsDisallowed: !allowed })
                statuses.set(normalizeUrl(ev.finalUrl) ?? ev.finalUrl, ev.status)
                pageLinks.set(ev.finalUrl, [...page.internalLinks])
                observedByUrl.set(normalizeFindingUrl(ev.finalUrl), { indexability, findings: pageFindings })

                const obs = yield* observations.insert({
                  businessId: run.businessId,
                  runId: run.id,
                  siteTargetId: target.id,
                  url: candidate,
                  canonicalUrl: normalizeUrl(candidate) ?? candidate,
                  finalUrl: ev.finalUrl,
                  discoveredVia: sitemapProvenance.has(candidate) ? "SITEMAP" : "ROOT",
                  provenance: { discoveredFrom: sitemapProvenance.get(candidate) ?? "site root", inspector: INSPECTOR_VERSION },
                  startedAt: ev.startedAt,
                  completedAt: ev.completedAt,
                  httpStatus: ev.status,
                  contentType: ev.contentType,
                  redirectChain: [...ev.redirectChain],
                  headers: ev.headers,
                  bodyDigest: ev.bodyDigest,
                  bodyBytes: ev.bodyBytes,
                  indexability,
                  evidence: {
                    robotsMeta: page.robotsMeta,
                    xRobotsTag: page.xRobotsTag,
                    canonical: page.canonical,
                    title: page.title,
                    metaDescription: page.metaDescription,
                    h1Present: page.h1Present,
                    imagesMissingAlt: page.imagesMissingAlt,
                    imagesTotal: page.imagesTotal,
                    jsonLdInvalid: page.jsonLdBlocks.filter((b) => !b.valid).length,
                    redirectChain: [...ev.redirectChain],
                  },
                  collectionState: "FETCHED",
                }).pipe(Effect.catchAll(() => Effect.succeed(null)))

                for (const f of pageFindings) {
                  const created = yield* persistFinding(run, target.id, obs?.id ?? null, candidate, ev.finalUrl, f, ev)
                  if (created) findingsCount += 1
                }
                inspected += 1
                yield* runs.incrementCounters(run.businessId, run.id, { urlsInspected: 1, findingsProduced: pageFindings.length, bytesDownloaded: ev.bodyBytes })
              }

              // 4. Link graph: broken internal links + possible orphans.
              {
                const graph = buildLinkGraph(
                  {
                    pages: [...pageLinks.entries()].map(([url, links]) => ({ url, links })),
                    sitemapUrls,
                    origin,
                  },
                  { knownStatuses: statuses },
                )
                for (const b of graph.brokenInternal) {
                  const f: DerivedFinding = {
                    findingKind: "BROKEN_INTERNAL_LINK",
                    severity: "MEDIUM",
                    category: "CRAWL_INDEX_RISK",
                    url: b.from,
                    evidence: { from: b.from, to: b.to, status: 404 },
                    diagnosis: `An internal link points to ${b.to}, which returns 404.`,
                    recommendedAction: "Update the link to the closest live replacement, or restore the target page.",
                    confidence: "HIGH",
                  }
                  const created = yield* persistFinding(run, target.id, null, b.from, b.from, f, null)
                  if (created) findingsCount += 1
                }
                for (const orphan of graph.possibleOrphans.slice(0, 20)) {
                  const f: DerivedFinding = {
                    findingKind: "POSSIBLE_ORPHAN",
                    severity: "MEDIUM",
                    category: "CRAWL_INDEX_RISK",
                    url: orphan,
                    evidence: { url: orphan, discoveredFrom: sitemapProvenance.get(orphan) ?? "sitemap", note: "present in sitemap but not linked from inspected pages" },
                    diagnosis: "This URL appears in the sitemap but was not reachable through inspected internal links.",
                    recommendedAction: "Link it from relevant pages, or remove it from the sitemap if it should not be discovered.",
                    confidence: "MEDIUM",
                  }
                  const created = yield* persistFinding(run, target.id, null, orphan, orphan, f, null)
                  if (created) findingsCount += 1
                }
              }

              // Missing sitemap is informational, never a failure — and only
              // worth recording when the run actually inspected something
              // (a failed run must not leave findings that look like results).
              if (sitemapUrls.length === 0 && inspected > 0) {
                const f: DerivedFinding = {
                  findingKind: "SITEMAP_MISSING",
                  severity: "LOW",
                  category: "INFORMATIONAL",
                  url: target.rootUrl,
                  evidence: { checked: [`${origin}/robots.txt`, `${origin}/sitemap.xml`] },
                  diagnosis: "No sitemap was discovered via robots.txt or /sitemap.xml.",
                  recommendedAction: "Publish a sitemap and reference it from robots.txt to aid discovery.",
                  confidence: "MEDIUM",
                }
                const created = yield* persistFinding(run, target.id, null, target.rootUrl, target.rootUrl, f, null)
                if (created) findingsCount += 1
              }

              // 5. Verification reconciliation: pending findings re-checked
              // against fresh observations. Fixed only when the live page no
              // longer exhibits the issue; otherwise honestly NOT_FIXED.
              yield* reconcileVerifications(run, target.id, observedByUrl)

              const elapsed = Date.now() - startedMs
              void elapsed
              if (inspected === 0 && failed > 0) {
                return yield* failRun(run, "FETCH_FAILED", `${failed} URLs failed without evidence; inspection incomplete`)
              }
              const terminal = failed > 0 ? "PARTIALLY_SUCCEEDED" : "SUCCEEDED"
              yield* runs.markFinished(run.businessId, run.id, terminal, failed > 0 ? "PAGE_FAILURES" : null, failed > 0 ? `${failed} URLs failed with evidence preserved` : null)
              yield* events.append({ businessId: run.businessId, runId: run.id, kind: "RUN_SUCCEEDED", payload: { inspected, failed, findings: findingsCount } }).pipe(Effect.ignore)
              yield* log(run, terminal === "SUCCEEDED" ? "succeeded" : "partial", { inspected, failed, findings: findingsCount })
              return true

              function persistFinding(
                own: SiteRunRow,
                siteTargetId: string,
                pageObservationId: string | null,
                url: string,
                finalUrl: string,
                f: DerivedFinding,
                fetchEv: { bodyDigest: string | null } | null,
              ): Effect.Effect<boolean, SqlError | RowDecodeError> {
                return Effect.gen(function*() {
                  const digest = evidenceDigest(f.evidence as Record<string, unknown>)
                  const identityKey = findingIdentityKey({ businessId: own.businessId, url: finalUrl, findingKind: f.findingKind as never, evidence: f.evidence as Record<string, unknown> })
                  const { row, created } = yield* findings.upsertByIdentity({
                    businessId: own.businessId,
                    siteTargetId,
                    runId: own.id,
                    pageObservationId,
                    url: finalUrl,
                    canonicalUrl: normalizeFindingUrl(finalUrl),
                    findingKind: f.findingKind,
                    severity: f.severity,
                    category: f.category,
                    evidence: f.evidence,
                    diagnosis: f.diagnosis,
                    recommendedAction: f.recommendedAction,
                    confidence: f.confidence,
                    sourceDigest: fetchEv?.bodyDigest ?? null,
                    evidenceDigest: digest,
                    identityKey,
                  })
                  if (created) {
                    yield* events.append({ businessId: own.businessId, runId: own.id, findingId: row.id, kind: "FINDING_CREATED", payload: { kind: f.findingKind, url: finalUrl } }).pipe(Effect.ignore)
                    const draft = proposeFix(f)
                    if (draft) {
                      yield* proposals.create({
                        businessId: own.businessId,
                        findingId: row.id,
                        fixKind: draft.fixKind as string,
                        target: draft.target,
                        beforeText: draft.before,
                        afterText: draft.after,
                        patch: draft.patch,
                        rationale: draft.rationale,
                        risk: draft.risk,
                        classification: draft.classification,
                        requiresApproval: draft.requiresApproval,
                      }).pipe(Effect.ignore)
                      yield* events.append({ businessId: own.businessId, runId: own.id, findingId: row.id, kind: "FIX_PROPOSED", payload: { fixKind: draft.fixKind } }).pipe(Effect.ignore)
                    }
                    void url
                  }
                  return created
                })
              }

              function persistSitemapInvalidFinding(own: SiteRunRow, siteTargetId: string, sitemapUrl: string): Effect.Effect<void, SqlError | RowDecodeError> {
                return Effect.gen(function*() {
                  const f: DerivedFinding = {
                    findingKind: "SITEMAP_INVALID",
                    severity: "HIGH",
                    category: "CRAWL_INDEX_RISK",
                    url: sitemapUrl,
                    evidence: { sitemapUrl, error: "parse failure" },
                    diagnosis: "A sitemap document could not be parsed, so its URLs cannot be discovered.",
                    recommendedAction: "Repair the sitemap XML so it parses.",
                    confidence: "HIGH",
                  }
                  yield* persistFinding(own, siteTargetId, null, sitemapUrl, sitemapUrl, f, null).pipe(Effect.ignore)
                })
              }

              function reconcileVerifications(
                own: SiteRunRow,
                siteTargetId: string,
                fresh: Map<string, { indexability: string; findings: DerivedFinding[] }>,
              ): Effect.Effect<void, SqlError | RowDecodeError> {
                return Effect.gen(function*() {
                  const pending = (yield* findings.listByTarget(own.businessId, siteTargetId)).filter((r) =>
                    ["FIX_APPLIED", "VERIFICATION_PENDING"].includes(r.status),
                  )
                  for (const p of pending) {
                    const key = normalizeFindingUrl(p.url)
                    const seen = fresh.get(key)
                    if (!seen) continue // URL not in this run: stays pending, never guessed.
                    const stillPresent = seen.findings.some((f) => f.findingKind === p.findingKind)
                    const result = stillPresent ? "VERIFIED_NOT_FIXED" : "VERIFIED_FIXED"
                    const toStatus = stillPresent ? "VERIFIED_NOT_FIXED" : "VERIFIED_FIXED"
                    yield* verifications.create({
                      businessId: own.businessId,
                      findingId: p.id,
                      runId: own.id,
                      beforeDigest: p.sourceDigest,
                      afterDigest: null,
                      result,
                      detail: stillPresent ? "Live re-inspection still exhibits the issue." : "Ghostping verified the fix on the live site.",
                    }).pipe(Effect.ignore)
                    yield* findings.setStatus(own.businessId, p.id, toStatus, "SYSTEM", result, own.id).pipe(Effect.ignore)
                    yield* events.append({ businessId: own.businessId, runId: own.id, findingId: p.id, kind: "VERIFICATION_COMPLETED", payload: { result } }).pipe(Effect.ignore)
                  }
                })
              }
            })
          }
        })
      return { runOnce }
    }),
  )

export const SiteInspectionRunnerLive = makeSiteInspectionRunnerLive()
