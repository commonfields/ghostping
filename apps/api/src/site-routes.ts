// SEARCH_OPERATOR_V1 HTTP routes: site targets, runs, findings, fixes.
// All routes are account-scoped (business must belong to the session).
// Network fetching never happens in the request path; the worker owns it.
// Mutations touch only the site's configured repoRef.rootDir, constrained to
// an allowlisted workspace (or the OS temp dir in test/demo).
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Effect, Schema } from "effect"
import { tmpdir } from "node:os"
import {
  BusinessRepository,
  SiteActiveRunConflict,
  SiteFindingRepository,
  SiteFixProposalRepository,
  SiteGscRepository,
  SiteMutationRepository,
  SiteOperatorEventRepository,
  SitePageObservationRepository,
  SiteRunRepository,
  SiteTargetRepository,
  SiteVerificationRepository,
  type Session,
} from "@ghostping/db"
import {
  ApplyFixRequest,
  ApproveFixRequest,
  CreateSiteRequest,
  RecordMutationIdentityRequest,
  decodeRouteId,
} from "@ghostping/contracts"
import {
  GitSiteAdapter,
  LocalFileSiteAdapter,
  buildPatch,
  removeNoindexFromHtml,
} from "@ghostping/site-operator"
import {
  loadFindingDetail,
  loadSearchOverview,
  loadSiteFindings,
  loadSiteRuns,
  loadSites,
  canRecordMutationState,
  validateSiteRoot,
} from "./site-operator.js"

const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  HttpServerResponse.json(body, { status, headers })

const readJson = Effect.flatMap(
  HttpServerRequest.HttpServerRequest,
  (req) => req.json as Effect.Effect<unknown>,
)

const decodeRequest = <A, I>(schema: Schema.Schema<A, I>, raw: unknown): A | null => {
  const parsed = Schema.decodeUnknownEither(schema)(raw)
  return parsed._tag === "Right" ? parsed.right : null
}

const malformed = { _tag: "InvalidFactValue", reason: "malformed request" } as const
const isRouteId = (id: string): boolean => decodeRouteId(id)._tag === "Right"

const allowedRoot = (rootDir: string): boolean => {
  const roots = (process.env["SITE_OPERATOR_ROOTS"] ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (rootDir.startsWith(tmpdir())) return true
  if (rootDir.startsWith("/private/var/folders/")) return true
  for (const r of roots) {
    if (rootDir === r || rootDir.startsWith(r.endsWith("/") ? r : `${r}/`)) return true
  }
  return false
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const siteApi = (withSession: any): HttpRouter.HttpRouter =>
  HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/businesses/:id/search/overview",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const overview = yield* loadSearchOverview(session.accountId, businessId)
          if (!overview) return yield* json(404, { _tag: "BusinessNotFound" })
          return yield* json(200, { overview })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.get(
      "/api/businesses/:id/search/sites",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const sites = yield* loadSites(session.accountId, businessId)
          if (!sites) return yield* json(404, { _tag: "BusinessNotFound" })
          return yield* json(200, { sites })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.post(
      "/api/businesses/:id/search/sites",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
          const body = decodeRequest(CreateSiteRequest, (yield* readJson) as unknown)
          if (!body) return yield* json(422, malformed)
          const checked = validateSiteRoot(body.rootUrl)
          if (!checked.ok) return yield* json(422, { _tag: "InvalidFactValue", reason: checked.reason })
          const sites = yield* SiteTargetRepository
          const created = yield* sites.create({
            businessId,
            rootUrl: checked.rootUrl,
            canonicalOrigin: checked.canonicalOrigin,
            pathPrefix: checked.pathPrefix,
            adapterKind: body.adapterKind ?? "LOCAL_FILE",
            repoRef: body.repoRef ?? {},
          })
          return yield* json(200, { site: created })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.get(
      "/api/businesses/:id/search/sites/:siteId/runs",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          if (!isRouteId(p["id"] as string)) return yield* json(422, malformed)
          const runs = yield* loadSiteRuns(session.accountId, p["id"] as string, p["siteId"] as string)
          if (!runs) return yield* json(404, { _tag: "BusinessNotFound" })
          return yield* json(200, { runs })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.post(
      "/api/businesses/:id/search/sites/:siteId/runs",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          const businessId = p["id"] as string
          const siteId = p["siteId"] as string
          if (!isRouteId(businessId) || !isRouteId(siteId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
          const sites = yield* SiteTargetRepository
          if (!(yield* sites.getScoped(businessId, siteId))) return yield* json(404, { _tag: "SiteNotFound" })
          const runs = yield* SiteRunRepository
          const created = yield* runs.enqueue({ businessId, siteTargetId: siteId }).pipe(
            Effect.catchAll((e) => (e instanceof SiteActiveRunConflict ? Effect.succeed(null) : Effect.fail(e))),
          )
          if (!created) return yield* json(409, { _tag: "Conflict", message: "site already has an active run" })
          const events = yield* SiteOperatorEventRepository
          yield* events.append({ businessId, runId: created.id, kind: "RUN_QUEUED", payload: { siteId } }).pipe(Effect.ignore)
          return yield* json(200, { run: created })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.get(
      "/api/businesses/:id/search/sites/:siteId/runs/:runId",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          const businessId = p["id"] as string
          if (!isRouteId(businessId) || !isRouteId(p["runId"] as string)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
          const runs = yield* SiteRunRepository
          const run = yield* runs.getScoped(businessId, p["runId"] as string)
          if (!run) return yield* json(404, { _tag: "RunNotFound" })
          const obs = yield* SitePageObservationRepository
          const events = yield* SiteOperatorEventRepository
          return yield* json(200, {
            run,
            observations: yield* obs.listByRun(businessId, run.id),
            events: yield* events.listByRun(businessId, run.id),
          })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.get(
      "/api/businesses/:id/search/sites/:siteId/findings",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          if (!isRouteId(p["id"] as string)) return yield* json(422, malformed)
          const rows = yield* loadSiteFindings(session.accountId, p["id"] as string, p["siteId"] as string)
          if (!rows) return yield* json(404, { _tag: "BusinessNotFound" })
          return yield* json(200, { findings: rows })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.get(
      "/api/businesses/:id/search/sites/:siteId/findings/:findingId",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          if (!isRouteId(p["id"] as string)) return yield* json(422, malformed)
          const detail = yield* loadFindingDetail(session.accountId, p["id"] as string, p["siteId"] as string, p["findingId"] as string)
          if (!detail) return yield* json(404, { _tag: "FindingNotFound" })
          return yield* json(200, detail)
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // Approve (or reject) a proposed fix. Approval moves the finding to
    // APPROVED via AWAITING_APPROVAL; rejection returns it to OPEN.
    HttpRouter.post(
      "/api/businesses/:id/search/fixes/:proposalId/approve",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          const businessId = p["id"] as string
          const proposalId = p["proposalId"] as string
          if (!isRouteId(businessId) || !isRouteId(proposalId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
          const body = decodeRequest(ApproveFixRequest, (yield* readJson) as unknown)
          if (!body) return yield* json(422, malformed)
          const proposals = yield* SiteFixProposalRepository
          const proposal = yield* proposals.getScoped(businessId, proposalId)
          if (!proposal) return yield* json(404, { _tag: "FixNotFound" })
          if (proposal.status !== "PROPOSED") return yield* json(409, { _tag: "Conflict", message: `proposal is ${proposal.status}` })
          const findings = yield* SiteFindingRepository
          const finding = yield* findings.getScoped(businessId, proposal.findingId)
          if (!finding) return yield* json(404, { _tag: "FindingNotFound" })
          if (body.approved) {
            yield* proposals.setStatus(businessId, proposalId, "APPROVED", session.userId)
            // OPEN -> AWAITING_APPROVAL -> APPROVED preserves history.
            if (finding.status === "OPEN") yield* findings.setStatus(businessId, finding.id, "AWAITING_APPROVAL", session.userId, "fix proposed", null)
            const updated = yield* findings.getScoped(businessId, finding.id)
            if (updated && updated.status === "AWAITING_APPROVAL") {
              yield* findings.setStatus(businessId, finding.id, "APPROVED", session.userId, `fix approved by operator`, null)
            }
            const events = yield* SiteOperatorEventRepository
            yield* events.append({ businessId, findingId: finding.id, kind: "APPROVAL_GRANTED", payload: { proposalId, by: session.userId } }).pipe(Effect.ignore)
            return yield* json(200, { proposal: yield* proposals.getScoped(businessId, proposalId) })
          }
          yield* proposals.setStatus(businessId, proposalId, "REJECTED", session.userId)
          if (finding.status === "AWAITING_APPROVAL") yield* findings.setStatus(businessId, finding.id, "OPEN", session.userId, "fix rejected", null)
          return yield* json(200, { proposal: yield* proposals.getScoped(businessId, proposalId) })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // Apply an approved fix through the site adapter. Records the mutation
    // identity (branch/commit/PR) and moves the finding to FIX_APPLIED.
    // Ghostping never merges automatically; GITHUB without credentials fails
    // closed with a blocked message.
    HttpRouter.post(
      "/api/businesses/:id/search/fixes/:proposalId/apply",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          const businessId = p["id"] as string
          const proposalId = p["proposalId"] as string
          if (!isRouteId(businessId) || !isRouteId(proposalId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
          const body = decodeRequest(ApplyFixRequest, (yield* readJson) as unknown)
          // Empty body is valid (all fields optional); only malformed JSON fails.
          const requestedFile = body?.filePath ?? null
          const requestedBranch = body?.branch ?? null
          const proposals = yield* SiteFixProposalRepository
          const proposal = yield* proposals.getScoped(businessId, proposalId)
          if (!proposal) return yield* json(404, { _tag: "FixNotFound" })
          if (proposal.status !== "APPROVED") return yield* json(409, { _tag: "Conflict", message: "proposal must be APPROVED before applying" })
          if (proposal.classification === "MANUAL_ONLY") {
            return yield* json(422, { _tag: "InvalidFactValue", reason: "this finding is MANUAL_ONLY: apply the change by hand, then run verification" })
          }
          const findings = yield* SiteFindingRepository
          const finding = yield* findings.getScoped(businessId, proposal.findingId)
          if (!finding) return yield* json(404, { _tag: "FindingNotFound" })
          const sites = yield* SiteTargetRepository
          const site = yield* sites.getScoped(businessId, finding.siteTargetId)
          if (!site) return yield* json(404, { _tag: "SiteNotFound" })
          if (site.adapterKind === "GITHUB" && !process.env["GITHUB_TOKEN"]) {
            return yield* json(422, { _tag: "AdapterBlocked", reason: "GitHub integration requires GITHUB_TOKEN; connect the repository or use a git-backed checkout" })
          }
          const repoRef = (site.repoRef ?? {}) as Record<string, unknown>
          const rootDir = typeof repoRef["rootDir"] === "string" ? (repoRef["rootDir"] as string) : null
          if (!rootDir) {
            return yield* json(422, { _tag: "InvalidFactValue", reason: "site has no local checkout configured (repoRef.rootDir); map the finding to its source file first" })
          }
          if (!allowedRoot(rootDir)) {
            return yield* json(422, { _tag: "InvalidFactValue", reason: "repoRef.rootDir is outside the allowed workspace" })
          }
          const fileMap = (repoRef["fileMap"] ?? {}) as Record<string, string>
          const filePath = requestedFile ?? fileMap[finding.url] ?? fileMap[finding.canonicalUrl] ?? defaultFileForUrl(finding.url)
          if (!filePath) {
            return yield* json(422, { _tag: "InvalidFactValue", reason: "source mapping unknown: refusing to guess the file (MANUAL_ONLY)" })
          }
          const adapter = site.adapterKind === "GIT" ? GitSiteAdapter : LocalFileSiteAdapter
          const events = yield* SiteOperatorEventRepository
          yield* events.append({ businessId, findingId: finding.id, kind: "MUTATION_STARTED", payload: { proposalId, filePath } }).pipe(Effect.ignore)
          if (finding.findingKind === "BLOCKED_BY_META") {
            const before = yield* Effect.promise(() => adapter.inspect({ rootDir, filePath })).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            )
            if (before === null) {
              return yield* json(422, { _tag: "InvalidFactValue", reason: "source file not found; refusing to guess (MANUAL_ONLY)" })
            }
            const after = removeNoindexFromHtml(before)
            if (after === null) {
              return yield* json(422, { _tag: "InvalidFactValue", reason: "noindex pattern not found in source; refusing to guess" })
            }
            const patch = buildPatch(filePath, before, after)
            const branchName = requestedBranch ?? `ghostping/remove-noindex-${finding.id.slice(0, 8)}`
            const applied = yield* Effect.promise(() =>
              adapter.applyMutation({ rootDir, input: { filePath, before, after, message: `Remove noindex from ${finding.url}` }, branch: branchName }),
            ).pipe(Effect.catchAll((e) => Effect.succeed({ failed: String(e) } as const)))
            if ("failed" in (applied as Record<string, unknown>)) {
              return yield* json(500, { _tag: "MutationFailed", reason: String((applied as { failed: string }).failed).slice(0, 300) })
            }
            const m = applied as { branch: string | null; commitSha: string | null; prNumber: number | null; prUrl: string | null; detail: string }
            const mutations = yield* SiteMutationRepository
            const record = yield* mutations.create({
              businessId,
              fixProposalId: proposalId,
              findingId: finding.id,
              adapterKind: site.adapterKind,
              branch: m.branch,
              commitSha: m.commitSha,
              state: m.branch ? "BRANCH_CREATED" : "CREATED",
              detail: [m.detail, `patch:\n${patch}`].join("\n").slice(0, 4000),
            })
            if (finding.status === "APPROVED") yield* findings.setStatus(businessId, finding.id, "FIX_IN_PROGRESS", session.userId, "mutation started", null)
            yield* findings.setStatus(businessId, finding.id, "FIX_APPLIED", session.userId, `mutation ${record.id}`, null)
            yield* events.append({ businessId, findingId: finding.id, kind: "MUTATION_COMPLETED", payload: { mutationId: record.id, branch: m.branch, commit: m.commitSha } }).pipe(Effect.ignore)
            return yield* json(200, { mutation: record, patch })
          }
          return yield* json(422, { _tag: "InvalidFactValue", reason: `automated apply is not supported for ${finding.findingKind} in V1` })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // Request verification: marks the finding VERIFICATION_PENDING and queues
    // a fresh inspection run. The worker reconciles to VERIFIED_FIXED or
    // VERIFIED_NOT_FIXED against live re-observation (never on merge alone).
    HttpRouter.post(
      "/api/businesses/:id/search/findings/:findingId/verify",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          const businessId = p["id"] as string
          const findingId = p["findingId"] as string
          if (!isRouteId(businessId) || !isRouteId(findingId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
          const findings = yield* SiteFindingRepository
          const finding = yield* findings.getScoped(businessId, findingId)
          if (!finding) return yield* json(404, { _tag: "FindingNotFound" })
          if (!["FIX_APPLIED", "VERIFIED_NOT_FIXED", "OPEN"].includes(finding.status)) {
            return yield* json(409, { _tag: "Conflict", message: `cannot verify from status ${finding.status}` })
          }
          const runs = yield* SiteRunRepository
          const verifications = yield* SiteVerificationRepository
          const events = yield* SiteOperatorEventRepository
          if (finding.status === "FIX_APPLIED") {
            yield* findings.setStatus(businessId, finding.id, "VERIFICATION_PENDING", session.userId, "verification requested", null)
          }
          yield* verifications.create({ businessId, findingId: finding.id, result: "VERIFICATION_PENDING", detail: "verification run queued" }).pipe(Effect.ignore)
          yield* events.append({ businessId, findingId: finding.id, kind: "VERIFICATION_STARTED", payload: {} }).pipe(Effect.ignore)
          const queued = yield* runs.enqueue({ businessId, siteTargetId: finding.siteTargetId }).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )
          return yield* json(200, { verification: "VERIFICATION_PENDING", run: queued })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // Externally observed mutation identity: the operator creates the
    // commit/PR with normal git tooling (Ghostping never merges); this
    // endpoint records what was observed with guarded transitions.
    HttpRouter.post(
      "/api/businesses/:id/search/mutations/:mutationId/identity",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          const businessId = p["id"] as string
          const mutationId = p["mutationId"] as string
          if (!isRouteId(businessId) || !isRouteId(mutationId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
          const body = decodeRequest(RecordMutationIdentityRequest, (yield* readJson) as unknown)
          if (!body) return yield* json(422, malformed)
          if (body.prUrl !== undefined) {
            try {
              const u = new URL(body.prUrl)
              if (u.protocol !== "https:") return yield* json(422, { _tag: "InvalidFactValue", reason: "prUrl must be an https URL" })
            } catch {
              return yield* json(422, { _tag: "InvalidFactValue", reason: "prUrl must be an https URL" })
            }
          }
          const mutations = yield* SiteMutationRepository
          const current = yield* mutations.getScoped(businessId, mutationId)
          if (!current) return yield* json(404, { _tag: "MutationNotFound" })
          // Externally observed identity only: CREATED -> BRANCH_CREATED ->
          // PR_OPEN -> MERGED (or FAILED). Ghostping never merges.
          if (!canRecordMutationState(current.state, body.state)) {
            return yield* json(409, { _tag: "Conflict", message: `cannot record ${body.state} from ${current.state}` })
          }
          if (body.state === "PR_OPEN" && !body.prUrl && !current.prUrl) {
            return yield* json(422, { _tag: "InvalidFactValue", reason: "prUrl required to record PR_OPEN" })
          }
          const updated = yield* mutations.markState(businessId, mutationId, body.state, body.detail ?? null, {
            ...(body.branch !== undefined ? { branch: body.branch } : {}),
            ...(body.commitSha !== undefined ? { commitSha: body.commitSha } : {}),
            ...(body.prNumber !== undefined ? { prNumber: body.prNumber } : {}),
            ...(body.prUrl !== undefined ? { prUrl: body.prUrl } : {}),
          })
          return yield* json(200, { mutation: updated })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.get(
      "/api/businesses/:id/search/gsc",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
          const gsc = yield* SiteGscRepository
          const live = Boolean(process.env["GOOGLE_SEARCH_CONSOLE_CLIENT_ID"] && process.env["GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET"])
          return yield* json(200, {
            status: live ? "CONNECTED" : "BLOCKED_MISSING_CREDENTIALS",
            detail: live
              ? "connected"
              : "Live Search Console OAuth credentials are not configured. Provider contract is implemented; serving labeled fixtures only. SITE_INDEXABLE and GOOGLE_REPORTED_INDEXED are reported separately and never conflated.",
            properties: yield* gsc.listByBusiness(businessId),
            source: live ? "LIVE" : "FIXTURE",
          })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
  ) as HttpRouter.HttpRouter

const defaultFileForUrl = (url: string): string | null => {
  try {
    const u = new URL(url)
    const path = u.pathname
    if (path === "/" || path === "") return "index.html"
    const clean = path.replace(/\/$/, "").replace(/^\//, "")
    // Only deterministic static mappings: /foo -> foo.html, /foo/ -> foo/index.html.
    // Anything ambiguous returns null (MANUAL_ONLY, never guessed).
    if (!clean || clean.includes("..") || /[<>"|?*]/.test(clean)) return null
    if (/^[a-zA-Z0-9/_.-]+$/.test(clean)) {
      return clean.endsWith(".html") ? clean : `${clean}.html`
    }
    return null
  } catch {
    return null
  }
}
