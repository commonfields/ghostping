// Authority snapshot + refetch policy V1. Orchestration types only, no DB.
// A snapshot freezes one lineage per root: active head + distinct
// historical values. Forks, cycles, and headless components are
// UNSUPPORTED_AUTHORITY_STATE and skipped conservatively.

import { createHash } from "node:crypto"
import type { AuthorityLineage } from "./matcher.js"
import { MATCHER_VERSION } from "./matcher.js"

export { MATCHER_VERSION }

export interface FactRowInput {
  readonly id: string
  readonly lineageRootId: string
  readonly version: number
  readonly valueType: "TEXT" | "CURRENCY" | "BOOLEAN"
  readonly valueText: string
  readonly supersedesId: string | null
}

export type UnsupportedAuthorityReason = "FORK" | "CYCLE" | "NO_HEAD" | "SELF_SUPERSESSION" | "DANGLING_PARENT"

export interface UnsupportedLineage {
  readonly rootId: string
  readonly reason: UnsupportedAuthorityReason
}

export interface AuthoritySnapshotV1 {
  readonly lineages: ReadonlyArray<AuthorityLineage>
  readonly unsupported: ReadonlyArray<UnsupportedLineage>
  readonly digest: string
}

const normalizeExact = (s: string): string =>
  s.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n")

const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  const rec = v as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`
}

export const digestSnapshot = (lineages: ReadonlyArray<AuthorityLineage>): string =>
  createHash("sha256").update(stableStringify(lineages)).digest("hex")

/**
 * Build a frozen authority snapshot from fact rows. Deterministic: roots
 * sorted, versions ascending, one historical entry per distinct value
 * (metadata-only same-value versions stay CURRENT, never historical).
 */
export const buildAuthoritySnapshot = (facts: ReadonlyArray<FactRowInput>): AuthoritySnapshotV1 => {
  const byRoot = new Map<string, FactRowInput[]>()
  for (const f of facts) {
    const list = byRoot.get(f.lineageRootId) ?? []
    list.push(f)
    byRoot.set(f.lineageRootId, list)
  }
  const lineages: AuthorityLineage[] = []
  const unsupported: UnsupportedLineage[] = []

  for (const rootId of [...byRoot.keys()].sort()) {
    const rows = (byRoot.get(rootId) ?? []).slice().sort((a, b) => a.version - b.version || (a.id < b.id ? -1 : 1))
    const bad = checkStructure(rootId, rows)
    if (bad !== null) {
      unsupported.push({ rootId, reason: bad })
      continue
    }
    const head = rows[rows.length - 1]!
    const seenValues = new Set<string>()
    const historical: { factId: string; version: number; value: string }[] = []
    for (const r of rows) {
      if (r.id === head.id) continue
      if (normalizeExact(r.valueText) === normalizeExact(head.valueText)) continue // metadata-only
      const key = normalizeExact(r.valueText)
      if (seenValues.has(key)) continue
      seenValues.add(key)
      historical.push({ factId: r.id, version: r.version, value: r.valueText })
    }
    historical.sort((a, b) => a.version - b.version)
    lineages.push({
      rootId,
      activeId: head.id,
      activeVersion: head.version,
      valueType: head.valueType,
      currentValue: head.valueText,
      historicalValues: historical,
    })
  }
  lineages.sort((a, b) => (a.rootId < b.rootId ? -1 : a.rootId > b.rootId ? 1 : 0))
  return { lineages, unsupported, digest: digestSnapshot(lineages) }
}

const checkStructure = (rootId: string, rows: FactRowInput[]): UnsupportedAuthorityReason | null => {
  void rootId
  if (rows.length === 0) return "NO_HEAD"
  const ids = new Set(rows.map((r) => r.id))
  for (const r of rows) {
    if (r.supersedesId !== null && r.supersedesId === r.id) return "SELF_SUPERSESSION"
    if (r.supersedesId !== null && !ids.has(r.supersedesId)) return "DANGLING_PARENT"
  }
  // Fork: two rows superseding the same parent, or two rows sharing a version.
  const parentCount = new Map<string, number>()
  const versionCount = new Map<number, number>()
  for (const r of rows) {
    if (r.supersedesId !== null) parentCount.set(r.supersedesId, (parentCount.get(r.supersedesId) ?? 0) + 1)
    versionCount.set(r.version, (versionCount.get(r.version) ?? 0) + 1)
  }
  for (const n of parentCount.values()) if (n > 1) return "FORK"
  for (const n of versionCount.values()) if (n > 1) return "FORK"
  // Cycle: walk parent links from every row; a revisit means a cycle.
  for (const start of rows) {
    const seen = new Set<string>()
    let cur: string | null = start.supersedesId
    while (cur !== null) {
      if (seen.has(cur)) return "CYCLE"
      seen.add(cur)
      const next = rows.find((r) => r.id === cur)
      if (next === undefined) break
      cur = next.supersedesId
    }
  }
  // Heads: rows never named as a parent. Linear history has exactly one.
  const parented = new Set(rows.map((r) => r.supersedesId).filter((s): s is string => s !== null))
  const heads = rows.filter((r) => !parented.has(r.id))
  if (heads.length === 0) return "CYCLE"
  if (heads.length > 1) return "FORK"
  return null
}

/** Digest equality: same authority content. */
export const snapshotsEqual = (
  a: { readonly digest: string },
  b: { readonly digest: string },
): boolean => a.digest === b.digest

/**
 * Phase 12 refetch rule. Reuse (304, no body) is allowed only when the
 * authority digest and matcher version are both unchanged and a prior body
 * exists. Any change forces a full body re-fetch; never guess from old matches.
 */
export const shouldRefetchBody = (args: {
  readonly authoritySame: boolean
  readonly matcherSame: boolean
  readonly hasBody: boolean
}): boolean => {
  if (!args.hasBody) return true
  if (!args.authoritySame || !args.matcherSame) return true
  return false
}
