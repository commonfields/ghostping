// Safe apply V1: writes ONLY declared projection outputs plus Ghostping's
// own lock/receipt metadata. Fail-closed path security, symlink defense,
// atomic replacement (temp sibling + flush + rename). Never partial bytes.
// Receipts are append-only records of local writes — never publication.

import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { MATERIALIZATION_RECEIPT_SCHEMA, TRUTH_COMPILER_VERSION } from "./manifest.js"
import type { ProjectionArtifactV1 } from "./compiler.js"
import { EMPTY_LOCK, planProjection, type PlanEntry, type ProjectionLock } from "./plan.js"

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
  readonly source_fact_versions: ProjectionArtifactV1["source_fact_versions"]
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
}

/** Resolve a declared relative path to an absolute path inside root. */
export const resolveInsideRoot = (root: string, rel: string): string => {
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) throw new ApplyError("AbsoluteOutputPath", rel)
  const parts = rel.split("/")
  if (parts.some((s) => s === ".." || s === "")) throw new ApplyError("UnsafeOutputPath", rel)
  if (rel === ".ghostping" || rel.startsWith(".ghostping/") || rel.startsWith(".git/") || rel.includes("/.git/")) {
    throw new ApplyError("ReservedOutputPath", rel)
  }
  const abs = resolve(root, rel)
  const relBack = relative(resolve(root), abs)
  if (relBack === "" || relBack.startsWith("..") || resolve(root, relBack) !== abs) {
    throw new ApplyError("PathEscapesRoot", rel)
  }
  return abs
}

/** Walk every path component: reject symlinks, device files, missing parents
 * are created only as real directories. Resolved at actual write time. */
export const assertNoSymlinkEscape = async (root: string, abs: string, lstat: (p: string) => Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }>): Promise<void> => {
  const rootAbs = resolve(root)
  let cursor = rootAbs
  const rest = relative(rootAbs, abs).split(sep)
  for (const seg of rest.slice(0, -1)) {
    cursor = join(cursor, seg)
    let st
    try {
      st = await lstat(cursor)
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return // rest does not exist yet; nothing to escape through
      throw e
    }
    if (st.isSymbolicLink()) throw new ApplyError("SymlinkEscape", cursor)
    if (!st.isDirectory()) throw new ApplyError("NotADirectory", cursor)
  }
  try {
    const target = await lstat(abs)
    if (target.isSymbolicLink()) throw new ApplyError("SymlinkEscape", abs)
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e
  }
}

const defaultLstat = async (p: string) => {
  const st = await fs.lstat(p)
  return { isSymbolicLink: () => st.isSymbolicLink(), isDirectory: () => st.isDirectory(), isFile: () => st.isFile() }
};

export const applyArtifact = async (
  artifact: ProjectionArtifactV1,
  ctx: {
    businessKey: string
    manifestDigest: string
    actor: ReceiptActor
    now: string
    newId: () => string
  },
  io: ApplyIo & { lstat?: typeof defaultLstat; writeFileAtomic?: (abs: string, bytes: Uint8Array) => Promise<void> },
): Promise<{ entry: PlanEntry; receipt: MaterializationReceiptV1 | null }> => {
  const lock = await io.readLock().catch(() => EMPTY_LOCK)
  // Filesystem safety first: even a CONFLICT outcome must never launder a
  // symlink/traversal probe into a managed write path.
  const abs = resolveInsideRoot(io.root, artifact.relative_output_path)
  await assertNoSymlinkEscape(io.root, abs, io.lstat ?? defaultLstat)
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
      source_fact_versions: artifact.source_fact_versions,
      manifest_digest: ctx.manifestDigest,
      compiler_version: TRUTH_COMPILER_VERSION,
      applied_at: ctx.now,
      actor: ctx.actor.kind,
      actor_id: ctx.actor.id === null ? { state: "UNKNOWN" } : { state: "KNOWN", value: ctx.actor.id },
    }
    await io.appendReceipt(receipt)
    return { entry, receipt }
  }
  // CREATE or UPDATE: atomic sibling write + rename; never partial content.
  const writeAtomic =
    io.writeFileAtomic ??
    (async (path: string, data: Uint8Array) => {
      await fs.mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.ghostping-tmp-${randomUUID()}`
      const handle = await fs.open(tmp, "w")
      try {
        await handle.writeFile(data)
        await handle.sync()
        await handle.close()
      } catch (e) {
        try {
          await handle.close()
        } catch {
          // ignore
        }
        try {
          await fs.unlink(tmp)
        } catch {
          // ignore
        }
        throw e
      }
      await fs.rename(tmp, path)
    })
  await writeAtomic(abs, bytes)
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
    source_fact_versions: artifact.source_fact_versions,
    manifest_digest: ctx.manifestDigest,
    compiler_version: TRUTH_COMPILER_VERSION,
    applied_at: ctx.now,
    actor: ctx.actor.kind,
    actor_id: ctx.actor.id === null ? { state: "UNKNOWN" } : { state: "KNOWN", value: ctx.actor.id },
  }
  await io.appendReceipt(receipt)
  return { entry, receipt }
}
