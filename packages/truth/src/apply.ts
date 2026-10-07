// Safe apply V1: writes ONLY declared projection outputs plus OpenRecord's
// own lock/receipt metadata. Fail-closed path security, symlink defense,
// atomic replacement (temp sibling + flush + rename). Never partial bytes.
// Receipts are append-only records of local writes — never publication.

import { createHash } from "node:crypto"
import {
  ConcurrentModification,
  ContainmentError,
  PreconditionFailed,
  hasReservedSegment,
  resolveContainedPath,
  validateCandidate,
  writeContainedFile,
  type ContainmentCode,
  type WriteStage,
} from "@openrecord/fs-containment"
import { MATERIALIZATION_RECEIPT_SCHEMA, TRUTH_COMPILER_VERSION } from "./manifest.js"
import type { ProjectionArtifactV1, ProjectionSourceRefV1 } from "./compiler.js"
import { planProjection, type PlanEntry, type ProjectionLock } from "./plan.js"

export class ApplyError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail === undefined ? `ApplyError: ${code}` : `ApplyError: ${code}: ${detail}`)
  }
}

export interface ReceiptActor {
  readonly kind: "HUMAN" | "AGENT" | "SYSTEM" | "UNKNOWN"
  readonly id: string | null
}

export interface MaterializationReceiptV1 {
  readonly schema: typeof MATERIALIZATION_RECEIPT_SCHEMA
  readonly schema_version: 1
  readonly id: string
  readonly business_key: string
  readonly projection_id: string
  readonly output_path: string
  readonly action: "CREATED" | "UPDATED" | "UNCHANGED"
  readonly before_digest: { state: "KNOWN"; value: string } | { state: "NOT_APPLICABLE" } | { state: "UNKNOWN" }
  readonly after_digest: string
  readonly source_refs: ReadonlyArray<ProjectionSourceRefV1>
  readonly manifest_digest: string
  readonly compiler_version: typeof TRUTH_COMPILER_VERSION
  readonly applied_at: string
  readonly actor: ReceiptActor["kind"]
  readonly actor_id: { state: "KNOWN"; value: string } | { state: "UNKNOWN" }
}

export interface ApplyIo {
  readonly root: string
  readonly read: (rel: string) => Promise<Uint8Array | null>
  readonly readLock: () => Promise<ProjectionLock>
  readonly writeLock: (lock: ProjectionLock) => Promise<void>
  readonly appendReceipt: (receipt: MaterializationReceiptV1) => Promise<void>
  /** Test seam passed to the containment primitive's write stages. */
  readonly onWriteStage?: (stage: WriteStage) => Promise<void>
}

const CONTAINMENT_TO_APPLY: Partial<Record<ContainmentCode, string>> = {
  ABSOLUTE_PATH: "AbsoluteOutputPath",
  SYMLINK: "SymlinkEscape",
  HARDLINKED_FILE: "SymlinkEscape",
  NOT_A_DIRECTORY: "NotADirectory",
}

const toApplyError = (e: unknown, rel: string): unknown => {
  if (e instanceof ContainmentError) return new ApplyError(CONTAINMENT_TO_APPLY[e.code] ?? "UnsafeOutputPath", `${e.code}: ${rel}`)
  if (e instanceof PreconditionFailed || e instanceof ConcurrentModification) return new ApplyError("ConcurrentModification", rel)
  return e
}

/** Truth's output-path policy (reserved names) on top of the shared
 * lexical containment rules. Returns the validated relative path. */
export const resolveInsideRoot = (_root: string, rel: string): string => {
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) throw new ApplyError("AbsoluteOutputPath", rel)
  try {
    validateCandidate(rel)
  } catch (e) {
    throw toApplyError(e, rel)
  }
  // Case- and normalization-insensitive: on APFS/NTFS `.OPENRECORD/x` and
  // NFD spellings name the same directory as `.openrecord/x`.
  if (hasReservedSegment(rel, [".openrecord", ".git"])) throw new ApplyError("ReservedOutputPath", rel)
  return rel
}

export const applyArtifact = async (
  artifact: ProjectionArtifactV1,
  ctx: {
    businessKey: string
    manifestDigest: string
    actor: ReceiptActor
    now: string
    newId: () => string
  },
  io: ApplyIo,
): Promise<{ entry: PlanEntry; receipt: MaterializationReceiptV1 | null }> => {
  // Lock state must be known before planning: an unreadable lock fails the
  // apply instead of proceeding as if nothing were managed.
  let lock: ProjectionLock
  try {
    lock = await io.readLock()
  } catch (e) {
    throw new ApplyError("LockReadFailed", e instanceof Error ? e.message : String(e))
  }
  // Filesystem safety first: even a CONFLICT outcome must never launder a
  // symlink/traversal probe into a managed write path.
  const rel = resolveInsideRoot(io.root, artifact.relative_output_path)
  await resolveContainedPath(io.root, rel).catch((e: unknown) => {
    throw toApplyError(e, rel)
  })
  const entry = await planProjection(artifact, io, lock)
  if (entry.action === "CONFLICT" || entry.action === "STALE_MANAGED_ARTIFACT") return { entry, receipt: null }
  const bytes = new TextEncoder().encode(artifact.canonical_bytes)
  const afterDigest = createHash("sha256").update(bytes).digest("hex")
  if (afterDigest !== artifact.digest_sha256) throw new ApplyError("DigestMismatch", artifact.projection_id)
  if (entry.action === "UNCHANGED") {
    const receipt: MaterializationReceiptV1 = {
      schema: MATERIALIZATION_RECEIPT_SCHEMA,
      schema_version: 1,
      id: ctx.newId(),
      business_key: ctx.businessKey,
      projection_id: artifact.projection_id,
      output_path: artifact.relative_output_path,
      action: "UNCHANGED",
      before_digest: { state: "KNOWN", value: afterDigest },
      after_digest: afterDigest,
      source_refs: artifact.source_refs,
      manifest_digest: ctx.manifestDigest,
      compiler_version: TRUTH_COMPILER_VERSION,
      applied_at: ctx.now,
      actor: ctx.actor.kind,
      actor_id: ctx.actor.id === null ? { state: "UNKNOWN" } : { state: "KNOWN", value: ctx.actor.id },
    }
    await io.appendReceipt(receipt)
    return { entry, receipt }
  }
  // CREATE or UPDATE through the shared primitive: atomic sibling write +
  // rename, containment re-proved and the planned digest re-checked
  // immediately before the rename (a concurrent edit fails, never merges).
  const written = await writeContainedFile(io.root, rel, bytes, {
    expectedBeforeSha256: entry.existing_digest,
    createParents: true,
    ...(io.onWriteStage ? { onStage: io.onWriteStage } : {}),
  }).catch((e: unknown) => {
    throw toApplyError(e, rel)
  })
  // The lock and receipt record only bytes actually read back from disk.
  if (written.afterSha256 !== afterDigest) throw new ApplyError("ReadbackMismatch", rel)
  const nextLock: ProjectionLock = {
    projections: { ...lock.projections, [artifact.projection_id]: { digest: afterDigest, compiler: TRUTH_COMPILER_VERSION } },
  }
  await io.writeLock(nextLock)
  const receipt: MaterializationReceiptV1 = {
    schema: MATERIALIZATION_RECEIPT_SCHEMA,
    schema_version: 1,
    id: ctx.newId(),
    business_key: ctx.businessKey,
    projection_id: artifact.projection_id,
    output_path: artifact.relative_output_path,
    action: entry.action === "CREATE" ? "CREATED" : "UPDATED",
    before_digest: entry.existing_digest === null ? { state: "NOT_APPLICABLE" } : { state: "KNOWN", value: entry.existing_digest },
    after_digest: afterDigest,
    source_refs: artifact.source_refs,
    manifest_digest: ctx.manifestDigest,
    compiler_version: TRUTH_COMPILER_VERSION,
    applied_at: ctx.now,
    actor: ctx.actor.kind,
    actor_id: ctx.actor.id === null ? { state: "UNKNOWN" } : { state: "KNOWN", value: ctx.actor.id },
  }
  await io.appendReceipt(receipt)
  return { entry, receipt }
}
