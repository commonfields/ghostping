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
  /**
   * One manifest sync = one transaction. The implementation serializes
   * concurrent syncs for the same business (e.g. SELECT ... FOR UPDATE on
   * the business row), so first-sync mode acquisition, reads, mutations,
   * and provenance inserts commit or roll back together.
   */
  readonly transact: <T>(businessId: string, fn: (tx: FactTxStore) => Promise<T>) => Promise<T>
}

export interface FactTxStore extends AuthorityStore {
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
): Promise<SyncResult> =>
  store.transact(businessId, async (tx) => {
    await guardManifestSync(tx, businessId)
    const active = await tx.activeFacts(businessId)
    const managed = await tx.provenanceKeys(businessId)
    const byKey = new Map(active.map((f) => [f.key, f]))
    const created: string[] = []
    const superseded: string[] = []
    const retired: string[] = []
    const unchanged: string[] = []
    const resolved = new Map<string, ResolvedFact>()
    const seen = new Set<string>()
    const refFor = (key: string, factId: string, version: number): ResolvedFact["ref"] => ({
      kind: "AUTHORITATIVE_FACT",
      key,
      fact_id: factId,
      version,
      manifest_digest: manifest.digest,
    })
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
        const row = await tx.create(businessId, fact, bridged, provenance)
        created.push(fact.key)
        resolved.set(fact.key, { key: fact.key, value: fact.value, ref: refFor(fact.key, row.id, row.version) })
        continue
      }
      if (sameAuthority(current, fact)) {
        unchanged.push(fact.key)
        resolved.set(fact.key, { key: fact.key, value: fact.value, ref: refFor(fact.key, current.id, current.version) })
        continue
      }
      const row = await tx.supersede(businessId, current.id, fact, bridged, provenance)
      superseded.push(fact.key)
      resolved.set(fact.key, { key: fact.key, value: fact.value, ref: refFor(fact.key, row.id, row.version) })
    }
    // V1 manifest is complete desired state: retire managed facts that vanished.
    for (const key of managed) {
      if (seen.has(key)) continue
      const current = byKey.get(key)
      if (current === undefined) continue // already retired on an earlier sync
      await tx.retire(businessId, current.id)
      retired.push(key)
    }
    return { created, superseded, retired, unchanged, resolved }
  })
