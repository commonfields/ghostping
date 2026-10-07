// Mutation preconditions: an approval binds to one exact change.
//
// prepare: read the source through the containment primitive, apply the
//   deterministic transform, and record target path + before/after hashes.
//   patch_sha256 = sha256(plan version, target path, before hash, after
//   hash), so it identifies exactly which bytes become which bytes.
// approve (API): stores approved_patch_sha256 = the prepared patch_sha256.
// apply: refuses unless every binding still holds:
//   approved hash != prepared plan hash        -> APPROVAL_INVALIDATED
//   current file hash != before hash           -> PRECONDITION_FAILED
//   transform(current) hash != approved after  -> APPROVAL_INVALIDATED
//   bytes read back after the write != after   -> MUTATION_FAILED
// Nothing is written unless the first three hold, and the containment
// primitive re-checks the before hash immediately before its rename.
import {
  ContainmentError,
  PreconditionFailed,
  readContainedFile,
  sha256Hex,
  writeContainedFile,
  type ContainmentCode,
} from "@openrecord/fs-containment"
import { buildPatch, removeNoindexFromHtml } from "./fixes.js"
import type { FixKind } from "./types.js"

export const MUTATION_PLAN_VERSION = "site-mutation-plan/1"

/** Deterministic source transforms; only these fix kinds can be applied. */
export const SOURCE_TRANSFORMS: Partial<Record<FixKind, (source: string) => string | null>> = {
  REMOVE_NOINDEX_META: removeNoindexFromHtml,
}

export const transformFor = (fixKind: string): ((source: string) => string | null) | null =>
  (SOURCE_TRANSFORMS as Record<string, (source: string) => string | null>)[fixKind] ?? null

export interface MutationBinding {
  readonly targetPath: string
  readonly beforeSha256: string
  readonly afterSha256: string
}

export interface MutationPlan extends MutationBinding {
  readonly patch: string
  readonly patchSha256: string
}

export const patchHashOf = (b: MutationBinding): string =>
  sha256Hex(`${MUTATION_PLAN_VERSION}\n${b.targetPath}\n${b.beforeSha256}\n${b.afterSha256}`)

export type PrepareFailure =
  | { readonly _tag: "PathRejected"; readonly code: ContainmentCode }
  | { readonly _tag: "SourceNotFound" }
  | { readonly _tag: "TransformNotApplicable" }
  | { readonly _tag: "UnsupportedFixKind" }

export type ApplyFailure =
  | { readonly _tag: "PathRejected"; readonly code: ContainmentCode }
  | { readonly _tag: "APPROVAL_INVALIDATED"; readonly detail: string }
  | { readonly _tag: "PRECONDITION_FAILED"; readonly detail: string; readonly actualSha256: string | null }
  | { readonly _tag: "MUTATION_FAILED"; readonly detail: string; readonly actualSha256: string | null }

const decode = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export const prepareFileMutation = async (args: {
  rootDir: string
  targetPath: string
  fixKind: string
}): Promise<{ ok: true; plan: MutationPlan } | { ok: false; failure: PrepareFailure }> => {
  const transform = transformFor(args.fixKind)
  if (!transform) return { ok: false, failure: { _tag: "UnsupportedFixKind" } }
  let read: Awaited<ReturnType<typeof readContainedFile>>
  try {
    read = await readContainedFile(args.rootDir, args.targetPath)
  } catch (e) {
    if (e instanceof ContainmentError) return { ok: false, failure: { _tag: "PathRejected", code: e.code } }
    throw e
  }
  if (read === null) return { ok: false, failure: { _tag: "SourceNotFound" } }
  const before = decode(read.bytes)
  const after = before === null ? null : transform(before)
  if (before === null || after === null || after === before) return { ok: false, failure: { _tag: "TransformNotApplicable" } }
  const binding: MutationBinding = {
    targetPath: read.path.relative,
    beforeSha256: sha256Hex(read.bytes),
    afterSha256: sha256Hex(after),
  }
  return { ok: true, plan: { ...binding, patch: buildPatch(binding.targetPath, before, after), patchSha256: patchHashOf(binding) } }
}

export const applyApprovedMutation = async (args: {
  rootDir: string
  fixKind: string
  /** The plan as currently stored on the proposal. */
  plan: MutationBinding & { readonly patchSha256: string }
  /** The hash the human approved. */
  approvedPatchSha256: string
  /** Test seam for the post-write verification; defaults to the primitive. */
  write?: typeof writeContainedFile
}): Promise<{ ok: true; beforeSha256: string; afterSha256: string } | { ok: false; failure: ApplyFailure }> => {
  const { plan } = args
  if (patchHashOf(plan) !== plan.patchSha256) {
    return { ok: false, failure: { _tag: "APPROVAL_INVALIDATED", detail: "stored plan does not match its patch hash" } }
  }
  if (plan.patchSha256 !== args.approvedPatchSha256) {
    return { ok: false, failure: { _tag: "APPROVAL_INVALIDATED", detail: "the prepared change differs from the approved change; re-approve" } }
  }
  const transform = transformFor(args.fixKind)
  if (!transform) return { ok: false, failure: { _tag: "APPROVAL_INVALIDATED", detail: `no deterministic transform for ${args.fixKind}` } }
  try {
    const read = await readContainedFile(args.rootDir, plan.targetPath)
    const currentSha = read === null ? null : sha256Hex(read.bytes)
    if (read === null || currentSha !== plan.beforeSha256) {
      return { ok: false, failure: { _tag: "PRECONDITION_FAILED", detail: "source changed since the change was reviewed", actualSha256: currentSha } }
    }
    const source = decode(read.bytes)
    const after = source === null ? null : transform(source)
    if (after === null || sha256Hex(after) !== plan.afterSha256) {
      return { ok: false, failure: { _tag: "APPROVAL_INVALIDATED", detail: "the transform no longer produces the approved bytes" } }
    }
    const written = await (args.write ?? writeContainedFile)(args.rootDir, plan.targetPath, after, { expectedBeforeSha256: plan.beforeSha256 })
    if (written.afterSha256 !== plan.afterSha256) {
      return { ok: false, failure: { _tag: "MUTATION_FAILED", detail: "bytes read back after the write do not match the approved after hash", actualSha256: written.afterSha256 } }
    }
    return { ok: true, beforeSha256: plan.beforeSha256, afterSha256: written.afterSha256 }
  } catch (e) {
    if (e instanceof ContainmentError) return { ok: false, failure: { _tag: "PathRejected", code: e.code } }
    if (e instanceof PreconditionFailed) {
      return { ok: false, failure: { _tag: "PRECONDITION_FAILED", detail: "source changed immediately before the write", actualSha256: e.actualSha256 } }
    }
    throw e
  }
}
