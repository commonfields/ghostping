// Site mutation service: prepare -> approve -> apply with the approval bound
// to one exact change (see packages/site-operator/src/mutation.ts).
//
// prepare  reads the mapped source file through the containment primitive
//          and stores target path + before/after/patch hashes on the
//          proposal. A different patch on an APPROVED proposal invalidates
//          the approval (proposal -> PROPOSED, finding -> AWAITING_APPROVAL).
// approve  binds approved_patch_sha256 to the prepared patch.
// apply    looks up the idempotency key first (a replay returns the original
//          row, success or failure), then claims a mutation row (APPLYING)
//          before any write, runs the adapter, and records the outcome.
//
// Callers have already scoped businessId to the session's account.
import { Data, Effect } from "effect"
import { tmpdir } from "node:os"
import {
  SiteFindingRepository,
  SiteFixProposalRepository,
  SiteMutationRepository,
  SiteOperatorEventRepository,
  SiteTargetRepository,
  type SiteFixProposalRow,
  type SiteMutationRow,
  type SiteTargetRow,
} from "@openrecord/db"
import { resolveAllowedRoot } from "@openrecord/fs-containment"
import { GitSiteAdapter, LocalFileSiteAdapter, transformFor, type SiteAdapter } from "@openrecord/site-operator"

export interface ServiceResponse {
  readonly status: number
  readonly body: unknown
}

class AdapterThrew extends Data.TaggedError("AdapterThrew")<{ readonly detail: string }> {}

const io = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => new AdapterThrew({ detail: String(e).slice(0, 300) }) })

/**
 * Allowed checkout roots: SITE_OPERATOR_ROOTS (colon-separated). The OS
 * temp dir is allowed only under test or with SITE_OPERATOR_ALLOW_TMPDIR=1
 * (local demo); it is never allowed implicitly in production. A business may
 * only use checkouts under `<allowed root>/<business id>/` (tenant binding).
 */
export const siteOperatorRoots = (env: Record<string, string | undefined> = process.env): string[] => {
  const roots = (env["SITE_OPERATOR_ROOTS"] ?? "").split(":").map((s) => s.trim()).filter((s) => s.length > 0)
  if (env["NODE_ENV"] === "test" || env["SITE_OPERATOR_ALLOW_TMPDIR"] === "1") roots.push(tmpdir())
  return roots
}

// GITHUB never reaches here (resolveSite fails closed).
const adapterFor = (site: SiteTargetRow): SiteAdapter => (site.adapterKind === "GIT" ? GitSiteAdapter : LocalFileSiteAdapter)

/** Deterministic static mapping only; anything ambiguous is null (never guessed). */
export const defaultFileForUrl = (url: string): string | null => {
  try {
    const path = new URL(url).pathname
    if (path === "/" || path === "") return "index.html"
    const clean = path.replace(/\/$/, "").replace(/^\//, "")
    if (!/^[a-zA-Z0-9/_.-]+$/.test(clean)) return null
    return clean.endsWith(".html") ? clean : `${clean}.html`
  } catch {
    return null
  }
}

type SiteContext =
  | { readonly ok: true; readonly site: SiteTargetRow; readonly rootDir: string; readonly fileMap: Record<string, string> }
  | { readonly ok: false; readonly response: ServiceResponse }

const resolveSite = (businessId: string, siteTargetId: string, roots: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sites = yield* SiteTargetRepository
    const site = yield* sites.getScoped(businessId, siteTargetId)
    if (!site) return { ok: false, response: { status: 404, body: { _tag: "SiteNotFound" } } } as SiteContext
    if (site.adapterKind === "GITHUB") {
      // No hosted GitHub adapter executes in V1: fail closed instead of
      // silently falling through to the local-file adapter.
      const reason = process.env["GITHUB_TOKEN"]
        ? "the GitHub adapter is not implemented; use a git-backed checkout and record the PR identity"
        : "GitHub integration requires GITHUB_TOKEN; connect the repository or use a git-backed checkout"
      return { ok: false, response: { status: 422, body: { _tag: "AdapterBlocked", code: "ADAPTER_NOT_IMPLEMENTED", reason } } } as SiteContext
    }
    const repoRef = (site.repoRef ?? {}) as Record<string, unknown>
    const configured = typeof repoRef["rootDir"] === "string" ? (repoRef["rootDir"] as string) : null
    if (!configured) {
      return { ok: false, response: { status: 422, body: { _tag: "InvalidFactValue", reason: "site has no local checkout configured (repoRef.rootDir); map the finding to its source file first" } } } as SiteContext
    }
    const rootDir = yield* Effect.tryPromise(() => resolveAllowedRoot(configured, roots, businessId)).pipe(Effect.option)
    if (rootDir._tag === "None") {
      return { ok: false, response: { status: 422, body: { _tag: "InvalidFactValue", reason: "repoRef.rootDir is outside the allowed workspace (<allowed root>/<business id>/)" } } } as SiteContext
    }
    const rawMap = repoRef["fileMap"]
    const fileMap = rawMap !== null && typeof rawMap === "object" ? (rawMap as Record<string, string>) : {}
    return { ok: true, site, rootDir: rootDir.value, fileMap } as SiteContext
  })

const conflict = (message: string): ServiceResponse => ({ status: 409, body: { _tag: "Conflict", message } })

export const prepareFix = (businessId: string, proposalId: string, actor: string, requestedFile: string | null, roots = siteOperatorRoots()) =>
  Effect.gen(function*() {
    const proposals = yield* SiteFixProposalRepository
    const proposal = yield* proposals.getScoped(businessId, proposalId)
    if (!proposal) return { status: 404, body: { _tag: "FixNotFound" } } satisfies ServiceResponse
    if (proposal.status !== "PROPOSED" && proposal.status !== "APPROVED") return conflict(`proposal is ${proposal.status}`)
    if (proposal.classification === "MANUAL_ONLY" || !transformFor(proposal.fixKind)) {
      return { status: 422, body: { _tag: "InvalidFactValue", reason: `automated apply is not supported for ${proposal.fixKind}: apply the change by hand, then run verification` } } satisfies ServiceResponse
    }
    const findings = yield* SiteFindingRepository
    const finding = yield* findings.getScoped(businessId, proposal.findingId)
    if (!finding) return { status: 404, body: { _tag: "FindingNotFound" } } satisfies ServiceResponse
    const ctx = yield* resolveSite(businessId, finding.siteTargetId, roots)
    if (!ctx.ok) return ctx.response
    const filePath = requestedFile ?? ctx.fileMap[finding.url] ?? ctx.fileMap[finding.canonicalUrl] ?? defaultFileForUrl(finding.url)
    if (!filePath) return { status: 422, body: { _tag: "InvalidFactValue", reason: "source mapping unknown: refusing to guess the file (MANUAL_ONLY)" } } satisfies ServiceResponse
    const prepared = yield* io(() => adapterFor(ctx.site).prepareMutation({ rootDir: ctx.rootDir, targetPath: filePath, fixKind: proposal.fixKind }))
    if (!prepared.ok) {
      const f = prepared.failure
      if (f._tag === "PathRejected") return { status: 422, body: { _tag: "PathRejected", code: f.code } } satisfies ServiceResponse
      const reason = f._tag === "SourceNotFound"
        ? "source file not found; refusing to guess (MANUAL_ONLY)"
        : f._tag === "TransformNotApplicable"
          ? "the expected pattern was not found in the source; refusing to guess"
          : `automated apply is not supported for ${proposal.fixKind}`
      return { status: 422, body: { _tag: "InvalidFactValue", reason } } satisfies ServiceResponse
    }
    const { plan, baseRef } = prepared.prepared
    const recorded = yield* proposals.recordPlan(businessId, proposalId, {
      filePath: plan.targetPath,
      baseRef,
      beforeSha256: plan.beforeSha256,
      afterSha256: plan.afterSha256,
      patchSha256: plan.patchSha256,
      patch: plan.patch,
    })
    if (!recorded) return conflict("proposal changed concurrently; reload")
    if (recorded.approvalInvalidated && finding.status === "APPROVED") {
      yield* findings.setStatus(businessId, finding.id, "AWAITING_APPROVAL", actor, "approval invalidated: the prepared change differs from the approved change", null)
    }
    return { status: 200, body: { proposal: recorded.proposal, patch: plan.patch, approvalInvalidated: recorded.approvalInvalidated } } satisfies ServiceResponse
  })

export const approveFix = (businessId: string, proposalId: string, actor: string, approved: boolean) =>
  Effect.gen(function*() {
    const proposals = yield* SiteFixProposalRepository
    const proposal = yield* proposals.getScoped(businessId, proposalId)
    if (!proposal) return { status: 404, body: { _tag: "FixNotFound" } } satisfies ServiceResponse
    if (proposal.status !== "PROPOSED") return conflict(`proposal is ${proposal.status}`)
    const findings = yield* SiteFindingRepository
    const finding = yield* findings.getScoped(businessId, proposal.findingId)
    if (!finding) return { status: 404, body: { _tag: "FindingNotFound" } } satisfies ServiceResponse
    if (!approved) {
      yield* proposals.setStatus(businessId, proposalId, "REJECTED", actor)
      if (finding.status === "AWAITING_APPROVAL") yield* findings.setStatus(businessId, finding.id, "OPEN", actor, "fix rejected", null)
      return { status: 200, body: { proposal: yield* proposals.getScoped(businessId, proposalId) } } satisfies ServiceResponse
    }
    // Automated fixes are approved only against an exact prepared change.
    const automated = proposal.classification !== "MANUAL_ONLY" && transformFor(proposal.fixKind) !== null
    if (automated && proposal.patchSha256 === null) return conflict("prepare the exact change before approving it")
    const updated = automated
      ? yield* proposals.approveBound(businessId, proposalId, actor)
      : yield* proposals.setStatus(businessId, proposalId, "APPROVED", actor)
    if (!updated) return conflict("proposal changed concurrently; reload")
    // OPEN -> AWAITING_APPROVAL -> APPROVED preserves history.
    if (finding.status === "OPEN") yield* findings.setStatus(businessId, finding.id, "AWAITING_APPROVAL", actor, "fix proposed", null)
    const current = yield* findings.getScoped(businessId, finding.id)
    if (current && current.status === "AWAITING_APPROVAL") {
      yield* findings.setStatus(businessId, finding.id, "APPROVED", actor, "fix approved by operator", null)
    }
    const events = yield* SiteOperatorEventRepository
    yield* events.append({ businessId, findingId: finding.id, kind: "APPROVAL_GRANTED", payload: { proposalId, by: actor, approvedPatchSha256: updated.approvedPatchSha256 } }).pipe(Effect.ignore)
    return { status: 200, body: { proposal: updated } } satisfies ServiceResponse
  })

const FAILURE_STATUS: Record<string, { status: number; tag: string }> = {
  PRECONDITION_FAILED: { status: 409, tag: "PreconditionFailed" },
  APPROVAL_INVALIDATED: { status: 409, tag: "ApprovalInvalidated" },
  PATH_REJECTED: { status: 422, tag: "PathRejected" },
  MUTATION_FAILED: { status: 500, tag: "MutationFailed" },
  ADAPTER_FAILURE: { status: 500, tag: "AdapterFailure" },
}

/** The response for a stored mutation row; replays return exactly this. */
export const mutationResponse = (row: SiteMutationRow, patch: string | null, replayed: boolean): ServiceResponse => {
  if (row.state === "APPLYING") return { status: 409, body: { _tag: "Conflict", message: "this mutation is still being applied", mutation: row, replayed } }
  if (row.failureCode !== null) {
    const f = FAILURE_STATUS[row.failureCode] ?? { status: 500, tag: "MutationFailed" }
    return { status: f.status, body: { _tag: f.tag, reason: row.detail, mutation: row, replayed } }
  }
  return { status: 200, body: { mutation: row, patch, replayed } }
}

const defaultKey = (proposal: SiteFixProposalRow): string | null =>
  proposal.approvedPatchSha256 === null ? null : `${proposal.id}:${proposal.approvedPatchSha256}`

export const applyFix = (
  businessId: string,
  proposalId: string,
  actor: string,
  request: { readonly filePath?: string | undefined; readonly branch?: string | undefined; readonly idempotencyKey?: string | undefined },
  roots = siteOperatorRoots(),
) =>
  Effect.gen(function*() {
    const proposals = yield* SiteFixProposalRepository
    const mutations = yield* SiteMutationRepository
    const proposal = yield* proposals.getScoped(businessId, proposalId)
    if (!proposal) return { status: 404, body: { _tag: "FixNotFound" } } satisfies ServiceResponse
    const key = request.idempotencyKey ?? defaultKey(proposal)
    if (key !== null) {
      const existing = yield* mutations.findByIdempotencyKey(businessId, key)
      if (existing) {
        if (existing.fixProposalId !== proposalId) return conflict("idempotency key already used for a different change")
        return mutationResponse(existing, proposal.patch, true)
      }
    }
    if (proposal.status !== "APPROVED") return conflict("proposal must be APPROVED before applying")
    if (proposal.classification === "MANUAL_ONLY" || !transformFor(proposal.fixKind)) {
      return { status: 422, body: { _tag: "InvalidFactValue", reason: "this finding is MANUAL_ONLY: apply the change by hand, then run verification" } } satisfies ServiceResponse
    }
    if (
      key === null || proposal.approvedPatchSha256 === null || proposal.patchSha256 === null || proposal.filePath === null ||
      proposal.beforeSha256 === null || proposal.afterSha256 === null || proposal.approvedBy === null || proposal.approvedAt === null
    ) {
      return { status: 409, body: { _tag: "ApprovalInvalidated", reason: "approval is not bound to a prepared change; prepare and approve again" } } satisfies ServiceResponse
    }
    if (request.filePath !== undefined && request.filePath !== proposal.filePath) {
      return { status: 409, body: { _tag: "ApprovalInvalidated", reason: `the approved change targets ${proposal.filePath}; a different file needs a new prepared change and approval` } } satisfies ServiceResponse
    }
    const findings = yield* SiteFindingRepository
    const finding = yield* findings.getScoped(businessId, proposal.findingId)
    if (!finding) return { status: 404, body: { _tag: "FindingNotFound" } } satisfies ServiceResponse
    const ctx = yield* resolveSite(businessId, finding.siteTargetId, roots)
    if (!ctx.ok) return ctx.response
    // Claim before writing: a concurrent request with the same key gets the
    // claimed row back and writes nothing.
    const claim = yield* mutations.claim({
      businessId,
      fixProposalId: proposalId,
      findingId: finding.id,
      adapterKind: ctx.site.adapterKind,
      targetPath: proposal.filePath,
      baseRef: proposal.baseRef,
      beforeSha256: proposal.beforeSha256,
      afterSha256: proposal.afterSha256,
      approvedPatchSha256: proposal.approvedPatchSha256,
      approvedBy: proposal.approvedBy,
      approvedAt: proposal.approvedAt,
      idempotencyKey: key,
    })
    if (!claim.claimed) return mutationResponse(claim.row, proposal.patch, true)
    const events = yield* SiteOperatorEventRepository
    yield* events.append({ businessId, findingId: finding.id, kind: "MUTATION_STARTED", payload: { proposalId, mutationId: claim.row.id, filePath: proposal.filePath } }).pipe(Effect.ignore)
    const branch = request.branch ?? `openrecord/remove-noindex-${finding.id.slice(0, 8)}`
    const applied = yield* io(() =>
      adapterFor(ctx.site).applyMutation({
        rootDir: ctx.rootDir,
        fixKind: proposal.fixKind,
        plan: { targetPath: proposal.filePath!, beforeSha256: proposal.beforeSha256!, afterSha256: proposal.afterSha256!, patchSha256: proposal.patchSha256! },
        approvedPatchSha256: proposal.approvedPatchSha256!,
        branch,
      })).pipe(
      Effect.catchAll((e) => Effect.succeed({ ok: false as const, failure: { _tag: "MUTATION_FAILED" as const, detail: `adapter error: ${e.detail}`, actualSha256: null } })),
    )
    if (!applied.ok) {
      const f = applied.failure
      const failureCode = f._tag === "PathRejected" ? "PATH_REJECTED" : f._tag
      const detail = f._tag === "PathRejected" ? `path rejected: ${f.code}` : f.detail
      const actual = f._tag === "PRECONDITION_FAILED" || f._tag === "MUTATION_FAILED" ? f.actualSha256 : null
      const row = yield* mutations.complete(businessId, claim.row.id, { state: "FAILED", failureCode, branch: null, appliedAfterSha256: actual, detail })
      return mutationResponse(row ?? claim.row, proposal.patch, false)
    }
    const m = applied.result
    const row = yield* mutations.complete(businessId, claim.row.id, {
      state: m.branch ? "BRANCH_CREATED" : "CREATED",
      failureCode: null,
      branch: m.branch,
      appliedAfterSha256: m.afterSha256,
      detail: m.detail.slice(0, 4000),
    })
    if (finding.status === "APPROVED") yield* findings.setStatus(businessId, finding.id, "FIX_IN_PROGRESS", actor, "mutation started", null)
    yield* findings.setStatus(businessId, finding.id, "FIX_APPLIED", actor, `mutation ${claim.row.id}`, null)
    yield* events.append({ businessId, findingId: finding.id, kind: "MUTATION_COMPLETED", payload: { mutationId: claim.row.id, branch: m.branch, afterSha256: m.afterSha256 } }).pipe(Effect.ignore)
    return mutationResponse(row ?? claim.row, proposal.patch, false)
  })
