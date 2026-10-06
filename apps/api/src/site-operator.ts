// SEARCH_OPERATOR_V1 read/write model for the site operator API.
// Scoping rule: business must belong to the session account (404 otherwise).
// All customer URLs are untrusted input: validated as http(s) here, fetched
// only through the SSRF-safe worker path (never in the request handler).
import { Effect } from "effect"
import {
  SiteFindingEventRepository,
  SiteFindingRepository,
  SiteFixProposalRepository,
  SiteMutationRepository,
  SiteRunRepository,
  SiteTargetRepository,
  SiteVerificationRepository,
} from "@ghostping/db"
import { validateScope } from "@ghostping/discovery"
import { canTransitionFinding } from "@ghostping/site-operator"
import { scopedBusiness } from "./reads.js"

export const validateSiteRoot = (
  raw: unknown,
): { ok: true; rootUrl: string; canonicalOrigin: string; pathPrefix: string } | { ok: false; reason: string } => {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "rootUrl required" }
  const trimmed = raw.trim()
  if (trimmed.length > 2048) return { ok: false, reason: "rootUrl too long" }
  try {
    const v = validateScope(trimmed)
    return { ok: true, rootUrl: trimmed, canonicalOrigin: v.canonical_origin, pathPrefix: v.path_prefix }
  } catch {
    return { ok: false, reason: "URL must be an http(s) URL" }
  }
}

export const loadSites = (accountId: string, businessId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const sites = yield* SiteTargetRepository
    return yield* sites.listByBusiness(businessId)
  })

export const loadSiteRuns = (accountId: string, businessId: string, siteId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const sites = yield* SiteTargetRepository
    if (!(yield* sites.getScoped(businessId, siteId))) return null
    const runs = yield* SiteRunRepository
    return yield* runs.listByTarget(businessId, siteId)
  })

export const loadSiteFindings = (accountId: string, businessId: string, siteId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const sites = yield* SiteTargetRepository
    if (!(yield* sites.getScoped(businessId, siteId))) return null
    const findings = yield* SiteFindingRepository
    return yield* findings.listByTarget(businessId, siteId)
  })

export const loadFindingDetail = (accountId: string, businessId: string, _siteId: string, findingId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const findings = yield* SiteFindingRepository
    const row = yield* findings.getScoped(businessId, findingId)
    if (!row) return null
    const events = yield* SiteFindingEventRepository
    const proposals = yield* SiteFixProposalRepository
    const mutations = yield* SiteMutationRepository
    const verifications = yield* SiteVerificationRepository
    return {
      finding: row,
      history: yield* events.listByFinding(businessId, findingId),
      proposals: yield* proposals.listByFinding(businessId, findingId),
      mutations: yield* mutations.listByFinding(businessId, findingId),
      verifications: yield* verifications.listByFinding(businessId, findingId),
    }
  })

export const loadSearchOverview = (accountId: string, businessId: string) =>
  Effect.gen(function*() {
    if (!(yield* scopedBusiness(accountId, businessId))) return null
    const sites = yield* SiteTargetRepository
    const findings = yield* SiteFindingRepository
    const siteRows = yield* sites.listByBusiness(businessId)
    const all = yield* findings.listByBusiness(businessId)
    const open = all.filter((f) => !["VERIFIED_FIXED", "DISMISSED"].includes(f.status))
    const awaiting = all.filter((f) => f.status === "AWAITING_APPROVAL")
    const applied = all.filter((f) => ["FIX_APPLIED", "VERIFICATION_PENDING", "APPROVED", "FIX_IN_PROGRESS"].includes(f.status))
    const verified = all.filter((f) => f.status === "VERIFIED_FIXED")
    const pendingVerify = all.filter((f) => ["FIX_APPLIED", "VERIFICATION_PENDING"].includes(f.status))
    const runs = yield* SiteRunRepository
    let lastRun: { completedAt: string | null; urlsInspected: number } | null = null
    let lastSite: string | null = null
    for (const s of siteRows) {
      const rs = yield* runs.listByTarget(businessId, s.id)
      const done = rs.find((r) => r.completedAt !== null)
      if (done && (!lastRun || (done.completedAt ?? "") > (lastRun.completedAt ?? ""))) {
        lastRun = { completedAt: done.completedAt, urlsInspected: done.urlsInspected }
        lastSite = s.rootUrl
      }
    }
    const needsAttention = [...open]
      .sort((a, b) => {
        const sev = (s: string) => (s === "CRITICAL" ? 0 : s === "HIGH" ? 1 : s === "MEDIUM" ? 2 : 3)
        return sev(a.severity) - sev(b.severity) || (a.detectedAt < b.detectedAt ? 1 : -1)
      })
      .slice(0, 10)
    return {
      sites: siteRows.map((s) => ({ id: s.id, rootUrl: s.rootUrl, adapterKind: s.adapterKind })),
      website: lastSite,
      lastInspection: lastRun?.completedAt ?? null,
      urlsInspected: lastRun?.urlsInspected ?? 0,
      openFindings: open.length,
      awaitingApproval: awaiting.length,
      fixesApplied: applied.length,
      verificationPending: pendingVerify.length,
      verifiedFixes: verified.length,
      needsAttention,
    }
  })

/** Guarded finding transition with history append (no silent success). */
export const MUTATION_IDENTITY_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  CREATED: ["BRANCH_CREATED", "FAILED"],
  BRANCH_CREATED: ["PR_OPEN", "FAILED"],
  PR_OPEN: ["MERGED", "FAILED"],
  MERGED: [],
  FAILED: [],
}

export const canRecordMutationState = (from: string, to: string): boolean =>
  (MUTATION_IDENTITY_TRANSITIONS[from] ?? []).includes(to)

/** Guarded finding transition with history append (no silent success). */
export const transitionFinding = (
  businessId: string,
  findingId: string,
  toStatus: string,
  actor: string,
  detail?: string | null,
) =>
  Effect.gen(function*() {
    const findings = yield* SiteFindingRepository
    const current = yield* findings.getScoped(businessId, findingId)
    if (!current) return null
    if (!canTransitionFinding(current.status as never, toStatus as never)) {
      return { error: `InvalidFindingTransition: ${current.status} -> ${toStatus}` as const }
    }
    return yield* findings.setStatus(businessId, findingId, toStatus, actor, detail ?? null, null)
  })
