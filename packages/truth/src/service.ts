// Manifest sync service: repository manifest -> versioned authority facts.
// Idempotent: same manifest twice creates zero new versions. Changed values
// append new versions via existing supersession semantics; removed managed
// facts retire explicitly (never delete); unrelated facts are untouched.
// Each version carries provenance: key, manifest digest, optional source
// revision (operator-supplied only, never fabricated), timestamp, writer.

import { guardManifestSync, type AuthorityStore } from "./authority.js"
import type { ResolvedFact } from "./compiler.js"
import { encodeBridge, sameValue, type ManifestValue } from "./values.js"
import type { ManifestFactV1, TruthManifestV1 } from "./manifest.js"

export interface SyncedFact {
  readonly id: string
  readonly key: string
  readonly version: number
  readonly status: "ACTIVE" | "SUPERSEDED" | "RETIRED"
  readonly value: ManifestValue
  readonly valid_from: string
  readonly valid_until: string | null
}

export interface FactSyncStore extends AuthorityStore {
  readonly activeFacts: (businessId: string) => Promise<SyncedFact[]>
  readonly provenanceKeys: (businessId: string) => Promise<Set<string>>
  readonly create: (businessId: string, fact: ManifestFactV1, bridged: { value_text: string; value_type: string }, provenance: Provenance) => Promise<SyncedFact>
  readonly supersede: (businessId: string, prevId: string, fact: ManifestFactV1, bridged: { value_text: string; value_type: string }, provenance: Provenance) => Promise<SyncedFact>
  readonly retire: (businessId: string, factId: string) => Promise<void>
}

export interface Provenance {
  readonly manifest_key: string
  readonly manifest_digest: string
  readonly source_revision: string | null
  readonly synced_at: string
  readonly writer: "REPOSITORY_MANIFEST"
}

export interface SyncResult {
  readonly created: string[]
  readonly superseded: string[]
  readonly retired: string[]
  readonly unchanged: string[]
  readonly resolved: Map<string, ResolvedFact>
}

const sameAuthority = (active: SyncedFact, fact: ManifestFactV1): boolean => {
  if (!sameValue(active.value, fact.value)) return false
  if (active.valid_from !== fact.valid_from) return false
  if ((active.valid_until ?? null) !== fact.valid_until) return false
  return true
}

export const syncManifestFacts = async (
  manifest: TruthManifestV1,
  businessId: string,
  store: FactSyncStore,
  opts: { sourceRevision: string | null; now: string },
): Promise<SyncResult> => {
  await guardManifestSync(store, businessId)
  const active = await store.activeFacts(businessId)
  const managed = await store.provenanceKeys(businessId)
  const byKey = new Map(active.map((f) => [f.key, f]))
  const created: string[] = []
  const superseded: string[] = []
  const retired: string[] = []
  const unchanged: string[] = []
  const resolved = new Map<string, ResolvedFact>()
  const seen = new Set<string>()
  for (const fact of manifest.facts) {
    seen.add(fact.key)
    const provenance: Provenance = {
      manifest_key: fact.key,
      manifest_digest: manifest.digest,
      source_revision: opts.sourceRevision,
      synced_at: opts.now,
      writer: "REPOSITORY_MANIFEST",
    }
    const bridged = encodeBridge(fact.value)
    const current = byKey.get(fact.key)
    if (current === undefined) {
      const row = await store.create(businessId, fact, bridged, provenance)
      created.push(fact.key)
      resolved.set(fact.key, { key: fact.key, fact_id: row.id, version: row.version, value: fact.value })
      continue
    }
    if (sameAuthority(current, fact)) {
      unchanged.push(fact.key)
      resolved.set(fact.key, { key: fact.key, fact_id: current.id, version: current.version, value: fact.value })
      continue
    }
    const row = await store.supersede(businessId, current.id, fact, bridged, provenance)
    superseded.push(fact.key)
    resolved.set(fact.key, { key: fact.key, fact_id: row.id, version: row.version, value: fact.value })
  }
  // V1 manifest is complete desired state: retire managed facts that vanished.
  for (const key of managed) {
    if (seen.has(key)) continue
    const current = byKey.get(key)
    if (current === undefined) continue // already retired on an earlier sync
    await store.retire(businessId, current.id)
    retired.push(key)
  }
  return { created, superseded, retired, unchanged, resolved }
}
