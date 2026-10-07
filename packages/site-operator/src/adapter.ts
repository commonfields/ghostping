// SiteAdapter boundary: domain owns Finding -> FixProposal -> Approval ->
// Mutation -> Verification. Adapters implement the mechanics per platform.
// V1 ships a local-filesystem adapter (deterministic demo/tests) and a
// git-checkout adapter that stages the change inside an existing checkout.
// Hosted sources never shell out (architecture guard): commits and pull
// requests are created with normal git tooling by the operator (or CI) and
// their identity is recorded back via the mutation identity endpoint, so a
// merge is always observed, never performed by OpenRecord. WordPress/Shopify/
// Webflow/Squarespace/Wix adapters plug in later without domain changes.
//
// Every read and write goes through @openrecord/fs-containment; this module
// may not import node:fs (architecture test). Writes happen only through
// applyApprovedMutation, which enforces the approval/precondition binding.
import { ContainmentError, containedEntryKind, readContainedFile, type RootRef } from "@openrecord/fs-containment"
import { buildPatch, removeNoindexFromHtml } from "./fixes.js"
import {
  applyApprovedMutation,
  prepareFileMutation,
  type ApplyFailure,
  type MutationBinding,
  type MutationPlan,
  type PrepareFailure,
} from "./mutation.js"

export type AdapterKind = "LOCAL_FILE" | "GIT" | "GITHUB"

export interface MutationResult {
  readonly branch: string | null
  readonly commitSha: string | null
  readonly prNumber: number | null
  readonly prUrl: string | null
  readonly beforeSha256: string
  readonly afterSha256: string
  readonly detail: string
}

export type AdapterApplyFailure = ApplyFailure | { readonly _tag: "ADAPTER_FAILURE"; readonly detail: string }

export interface PreparedMutation {
  readonly plan: MutationPlan
  /** Checkout identity the plan was prepared against (git HEAD), if known. */
  readonly baseRef: string | null
}

export interface SiteAdapter {
  readonly kind: AdapterKind
  inspect(args: { rootDir: RootRef; filePath: string }): Promise<string | null>
  prepareMutation(args: { rootDir: RootRef; targetPath: string; fixKind: string }): Promise<{ ok: true; prepared: PreparedMutation } | { ok: false; failure: PrepareFailure }>
  applyMutation(args: {
    rootDir: RootRef
    fixKind: string
    plan: MutationBinding & { readonly patchSha256: string }
    approvedPatchSha256: string
    branch?: string
  }): Promise<{ ok: true; result: MutationResult } | { ok: false; failure: AdapterApplyFailure }>
  verifyMutation(args: { rootDir: RootRef; filePath: string; absent: string }): Promise<boolean>
}

const readText = async (rootDir: RootRef, filePath: string): Promise<string | null> => {
  try {
    const r = await readContainedFile(rootDir, filePath)
    return r === null ? null : new TextDecoder().decode(r.bytes)
  } catch (e) {
    if (e instanceof ContainmentError) return null
    throw e
  }
}

const inspect: SiteAdapter["inspect"] = ({ rootDir, filePath }) => readText(rootDir, filePath)

const verifyMutation: SiteAdapter["verifyMutation"] = async ({ rootDir, filePath, absent }) => {
  const content = await readText(rootDir, filePath)
  if (content === null) return false
  return !content.includes(absent)
}

/** Deterministic adapter over a local directory (tests + acceptance demo). */
export const LocalFileSiteAdapter: SiteAdapter = {
  kind: "LOCAL_FILE",
  inspect,
  async prepareMutation(args) {
    const r = await prepareFileMutation(args)
    return r.ok ? { ok: true, prepared: { plan: r.plan, baseRef: null } } : r
  },
  async applyMutation({ rootDir, fixKind, plan, approvedPatchSha256 }) {
    const r = await applyApprovedMutation({ rootDir, fixKind, plan, approvedPatchSha256 })
    if (!r.ok) return r
    return {
      ok: true,
      result: { branch: null, commitSha: null, prNumber: null, prUrl: null, beforeSha256: r.beforeSha256, afterSha256: r.afterSha256, detail: `wrote ${plan.targetPath}` },
    }
  },
  verifyMutation,
}

const isGitCheckout = async (rootDir: RootRef): Promise<boolean> => {
  try {
    const kind = await containedEntryKind(rootDir, ".git")
    return kind === "DIRECTORY" || kind === "FILE"
  } catch (e) {
    if (e instanceof ContainmentError) return false
    throw e
  }
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const REF = /^refs\/[A-Za-z0-9._/-]+$/

/** Best-effort HEAD commit of a plain .git directory; null when unknown. */
export const readGitHead = async (rootDir: RootRef): Promise<string | null> => {
  const head = (await readText(rootDir, ".git/HEAD"))?.trim() ?? null
  if (head === null) return null
  if (SHA.test(head)) return head
  const ref = head.startsWith("ref: ") ? head.slice(5).trim() : null
  if (ref === null || !REF.test(ref)) return null
  const loose = (await readText(rootDir, `.git/${ref}`))?.trim() ?? null
  if (loose !== null && SHA.test(loose)) return loose
  const packed = (await readText(rootDir, ".git/packed-refs")) ?? ""
  for (const line of packed.split("\n")) {
    const [sha, name] = line.trim().split(" ")
    if (name === ref && sha !== undefined && SHA.test(sha)) return sha
  }
  return null
}

/**
 * Git-checkout adapter: stages the patched file inside an existing git
 * checkout and names the branch the operator should commit on. It never
 * commits, never pushes, never merges: the commit/PR identity is observed
 * later (mutation identity endpoint) once the operator creates it with
 * normal git tooling. Outside a git checkout it fails closed with
 * ADAPTER_FAILURE (never a fake success).
 */
export const GitSiteAdapter: SiteAdapter = {
  kind: "GIT",
  inspect,
  async prepareMutation(args) {
    if (!(await isGitCheckout(args.rootDir))) return { ok: false, failure: { _tag: "SourceNotFound" } }
    const r = await prepareFileMutation(args)
    return r.ok ? { ok: true, prepared: { plan: r.plan, baseRef: await readGitHead(args.rootDir) } } : r
  },
  async applyMutation({ rootDir, fixKind, plan, approvedPatchSha256, branch }) {
    if (!(await isGitCheckout(rootDir))) {
      return { ok: false, failure: { _tag: "ADAPTER_FAILURE", detail: "target directory is not a git checkout" } }
    }
    const r = await applyApprovedMutation({ rootDir, fixKind, plan, approvedPatchSha256 })
    if (!r.ok) return r
    const name = branch ?? `openrecord/fix-${plan.patchSha256.slice(0, 12)}`
    return {
      ok: true,
      result: {
        branch: name,
        commitSha: null,
        prNumber: null,
        prUrl: null,
        beforeSha256: r.beforeSha256,
        afterSha256: r.afterSha256,
        detail: `staged ${plan.targetPath} for branch ${name}; commit and open a PR with normal git tooling, then record the identity`,
      },
    }
  },
  verifyMutation,
}

/** Map a noindex finding to a file mutation where the source is known. */
export const noindexMutationForHtml = (
  filePath: string,
  htmlBefore: string,
): { before: string; after: string; patch: string } | null => {
  const after = removeNoindexFromHtml(htmlBefore)
  if (after === null || after === htmlBefore) return null
  return { before: htmlBefore, after, patch: buildPatch(filePath, htmlBefore, after) }
}
