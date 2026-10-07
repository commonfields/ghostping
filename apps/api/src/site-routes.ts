// SEARCH_OPERATOR_V1 HTTP routes: site targets, runs, findings, fixes.
// All routes are account-scoped (business must belong to the session).
// Network fetching never happens in the request path; the worker owns it.
// Mutations touch only the site's configured repoRef.rootDir, constrained to
// SITE_OPERATOR_ROOTS through @openrecord/fs-containment (see
// site-mutations.ts for the prepare/approve/apply binding).
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Effect, Schema } from "effect"
import {
  BusinessRepository,
  SiteActiveRunConflict,
  SiteFindingRepository,
  SiteGscRepository,
  SiteMutationRepository,
  SiteOperatorEventRepository,
  SitePageObservationRepository,
  SiteRunRepository,
  SiteTargetRepository,
  SiteVerificationRepository,
  type Session,
} from "@openrecord/db"
import {
  ApplyFixRequest,
  ApproveFixRequest,
  CreateSiteRequest,
  PrepareFixRequest,
  RecordMutationIdentityRequest,
  decodeRouteId,
} from "@openrecord/contracts"
import {
  loadFindingDetail,
  loadSearchOverview,
  loadSiteFindings,
  loadSiteRuns,
  loadSites,
  canRecordMutationState,
  validateSiteRoot,
} from "./site-operator.js"
import { applyFix, approveFix, prepareFix } from "./site-mutations.js"

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
    // Prepare the exact change (target file + before/after/patch hashes) an
    // approval binds to. Re-preparing a different change invalidates approval.
    HttpRouter.post(
      "/api/businesses/:id/search/fixes/:proposalId/prepare",
      withSession((session: Session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          const businessId = p["id"] as string
          const proposalId = p["proposalId"] as string
          if (!isRouteId(businessId) || !isRouteId(proposalId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
          const raw = yield* readJson.pipe(Effect.orElseSucceed(() => ({})))
          const body = decodeRequest(PrepareFixRequest, raw)
          if (!body) return yield* json(422, malformed)
          const r = yield* prepareFix(businessId, proposalId, session.userId, body.filePath ?? null)
          return yield* json(r.status, r.body)
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // Approve (or reject) a proposed fix. Automated fixes approve only an
    // exact prepared change (approved_patch_sha256 = patch_sha256).
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
          const r = yield* approveFix(businessId, proposalId, session.userId, body.approved, body.patchSha256 ?? null)
          return yield* json(r.status, r.body)
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // Apply an approved fix through the site adapter. Enforces the approval
    // binding and preconditions; the same idempotency key returns the
    // original result. OpenRecord never merges automatically.
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
          // Empty body is valid (all fields optional); malformed fields fail.
          const raw = yield* readJson.pipe(Effect.orElseSucceed(() => ({})))
          const body = decodeRequest(ApplyFixRequest, raw)
          if (!body) return yield* json(422, malformed)
          const r = yield* applyFix(businessId, proposalId, session.userId, body)
          return yield* json(r.status, r.body)
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
    // commit/PR with normal git tooling (OpenRecord never merges); this
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
          // PR_OPEN -> MERGED (or FAILED). OpenRecord never merges.
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
          }, current.state)
          if (!updated) return yield* json(409, { _tag: "Conflict", message: "mutation changed concurrently; reload" })
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
