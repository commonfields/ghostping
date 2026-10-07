// Planner V1: desired artifacts vs working tree + managed-proof lock.
// Actions: CREATE | UPDATE | UNCHANGED | CONFLICT, plus STALE_MANAGED_ARTIFACT
// for projections removed from the manifest. Never PUBLISHED/DELIVERED/INDEXED.
// OpenRecord never overwrites a file it cannot prove it manages.

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { ProjectionArtifactV1, ProjectionSourceRefV1 } from "./compiler.js"

export type PlanAction = "CREATE" | "UPDATE" | "UNCHANGED" | "CONFLICT" | "STALE_MANAGED_ARTIFACT"

export interface PlanEntry {
  readonly projection_id: string
  readonly output_path: string
  readonly action: PlanAction
  readonly existing_digest: string | null
  readonly desired_digest: string | null
  readonly source_refs: ReadonlyArray<ProjectionSourceRefV1>
  readonly reason: string
}

export interface ProjectionLock {
  readonly projections: Record<string, { digest: string; compiler: string }>
}

export const EMPTY_LOCK: ProjectionLock = { projections: {} }

export const sha256File = async (bytes: Uint8Array): Promise<string> =>
  createHash("sha256").update(bytes).digest("hex")

const readIfExists = async (read: (path: string) => Promise<Uint8Array | null>, path: string): Promise<{ bytes: Uint8Array; digest: string } | null> => {
  const bytes = await read(path)
  if (bytes === null) return null
  return { bytes, digest: await sha256File(bytes) }
}

export const planProjection = async (
  artifact: ProjectionArtifactV1,
  io: { read: (path: string) => Promise<Uint8Array | null> },
  lock: ProjectionLock,
): Promise<PlanEntry> => {
  const base = {
    projection_id: artifact.projection_id,
    output_path: artifact.relative_output_path,
    source_refs: artifact.source_refs,
  }
  const existing = await readIfExists(io.read, artifact.relative_output_path)
  const proof = lock.projections[artifact.projection_id]
  if (existing === null) {
    return { ...base, action: "CREATE", existing_digest: null, desired_digest: artifact.digest_sha256, reason: "no file at output path" }
  }
  if (existing.digest === artifact.digest_sha256) {
    // Bytes already match. UNCHANGED only with managed proof; otherwise the
    // file is not ours to claim, even though writing would be a no-op.
    if (proof !== undefined && proof.digest === artifact.digest_sha256) {
      return { ...base, action: "UNCHANGED", existing_digest: existing.digest, desired_digest: artifact.digest_sha256, reason: "managed bytes match desired" }
    }
    return { ...base, action: "CONFLICT", existing_digest: existing.digest, desired_digest: artifact.digest_sha256, reason: "bytes match but no OpenRecord management proof" }
  }
  // Content differs from desired. UPDATE only when the lock proves the
  // current bytes are OpenRecord's last materialization.
  if (proof !== undefined && proof.digest === existing.digest) {
    return { ...base, action: "UPDATE", existing_digest: existing.digest, desired_digest: artifact.digest_sha256, reason: "managed file differs from desired" }
  }
  const reason = proof === undefined ? "existing file has no OpenRecord management proof" : "file was modified after last OpenRecord apply"
  return { ...base, action: "CONFLICT", existing_digest: existing.digest, desired_digest: artifact.digest_sha256, reason }
}

/** Projections in the lock but gone from the manifest: stale, never auto-deleted. */
export const planStale = (lock: ProjectionLock, manifestIds: ReadonlySet<string>, outputOf: (id: string) => string | null): PlanEntry[] =>
  Object.keys(lock.projections)
    .filter((id) => !manifestIds.has(id))
    .map((id) => ({
      projection_id: id,
      output_path: outputOf(id) ?? "(unknown)",
      action: "STALE_MANAGED_ARTIFACT" as const,
      existing_digest: lock.projections[id]?.digest ?? null,
      desired_digest: null,
      source_refs: [],
      reason: "projection removed from manifest; explicit deletion required",
    }))

export const readFileBytes = async (path: string): Promise<Uint8Array | null> => {
  try {
    return new Uint8Array(await readFile(path))
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null
    throw e
  }
}
