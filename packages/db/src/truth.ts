// Truth Projection V1 persistence (plain node-postgres, like migrate.ts):
// authority modes, repository provenance, and a manifest-sync store that
// runs under SET LOCAL ghostping.authority_sync = '1'. Only type imports
// flow db -> truth, so there is no runtime dependency cycle.

import pg from "pg"
import { AuthorityError, decodeBridge, type AuthorityStore, type FactSyncStore, type FactTxStore, type Provenance, type SyncedFact } from "@ghostping/truth"
import type { ManifestFactV1 } from "@ghostping/truth"

export { AuthorityError }

const iso = (v: unknown): string => new Date(String(v)).toISOString()

export interface PgSyncStore extends FactSyncStore {
  readonly close: () => Promise<void>
}

type TxQuery = (text: string, params?: unknown[]) => Promise<pg.QueryResult>

const toSynced = (row: Record<string, unknown>, key: string): SyncedFact => {
  const decoded = decodeBridge(String(row["value_text"]), String(row["value_type"]))
  if (!decoded) throw new Error(`NonCanonicalAuthorityValue: ${String(row["id"])}`)
  return {
    id: String(row["id"]),
    key,
    version: Number(row["version"]),
    status: String(row["status"]) as SyncedFact["status"],
    subject: String(row["subject"]),
    predicate: String(row["predicate"]),
    value: decoded,
    valid_from: iso(row["valid_from"]),
    valid_until: row["valid_until"] === null ? null : iso(row["valid_until"]),
    source_url: (row["source_url"] as string | null) ?? null,
  }
}

const txOps = (q: TxQuery): FactTxStore => ({
  mode: async (businessId: string) => {
    const r = await q(`SELECT writer FROM business_authority_mode WHERE business_id = $1`, [businessId])
    const w = (r.rows[0] as Record<string, unknown> | undefined)?.["writer"] as string | undefined
    return w === undefined ? null : (w as "HOSTED" | "REPOSITORY_MANIFEST")
  },
  factCount: async (businessId: string) => {
    const r = await q(`SELECT COUNT(*)::int AS n FROM authoritative_facts WHERE business_id = $1`, [businessId])
    return Number((r.rows[0] as Record<string, unknown>)?.["n"] ?? 0)
  },
  setMode: async (businessId: string, mode: "HOSTED" | "REPOSITORY_MANIFEST") => {
    await q(`INSERT INTO business_authority_mode (business_id, writer) VALUES ($1, $2) ON CONFLICT (business_id) DO UPDATE SET writer = EXCLUDED.writer, set_at = now()`, [businessId, mode])
  },
  activeFacts: async (businessId: string) => {
    const r = await q(
      `SELECT f.*, p.manifest_key, p.source_url FROM authoritative_facts f JOIN repository_fact_provenance p ON p.fact_id = f.id WHERE f.business_id = $1 AND f.status = 'ACTIVE' ORDER BY p.manifest_key`,
      [businessId],
    )
    return (r.rows as Record<string, unknown>[]).map((row) => toSynced(row, String(row["manifest_key"])))
  },
  provenanceKeys: async (businessId: string) => {
    const r = await q(`SELECT DISTINCT manifest_key FROM repository_fact_provenance WHERE business_id = $1`, [businessId])
    return new Set((r.rows as Record<string, unknown>[]).map((row) => String(row["manifest_key"])))
  },
  latestLineage: async (businessId: string) => {
    const r = await q(
      `SELECT DISTINCT ON (p.manifest_key) p.manifest_key, f.id, f.version, f.status FROM repository_fact_provenance p JOIN authoritative_facts f ON f.id = p.fact_id WHERE p.business_id = $1 ORDER BY p.manifest_key, f.version DESC`,
      [businessId],
    )
    return new Map(
      (r.rows as Record<string, unknown>[]).map((row) => [
        String(row["manifest_key"]),
        { id: String(row["id"]), version: Number(row["version"]), status: String(row["status"]) as SyncedFact["status"] },
      ]),
    )
  },
  create: async (businessId: string, fact: ManifestFactV1, bridged: { value_text: string; value_type: string }, provenance: Provenance) => {
    const rows = (
      await q(
        `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, valid_from, valid_until, source_kind) VALUES ($1,$2,$3,$4,$5,'ACTIVE',1,$6,$7,'MANUAL') RETURNING *`,
        [businessId, fact.subject, fact.predicate, bridged.value_text, bridged.value_type, fact.valid_from, fact.valid_until],
      )
    ).rows as Record<string, unknown>[]
    const row = rows[0]!
    await q(
      `INSERT INTO repository_fact_provenance (fact_id, business_id, manifest_key, manifest_digest, source_revision, synced_at, writer, source_url) VALUES ($1,$2,$3,$4,$5,$6,'REPOSITORY_MANIFEST',$7)`,
      [String(row["id"]), businessId, provenance.manifest_key, provenance.manifest_digest, provenance.source_revision, provenance.synced_at, fact.source_url],
    )
    return { ...toSynced(row, provenance.manifest_key), source_url: fact.source_url }
  },
  supersede: async (businessId: string, prevId: string, fact: ManifestFactV1, bridged: { value_text: string; value_type: string }, provenance: Provenance) => {
    const prev = (await q(`SELECT * FROM authoritative_facts WHERE id = $1 AND business_id = $2`, [prevId, businessId])).rows[0] as Record<string, unknown> | undefined
    if (!prev) throw new Error(`FactNotFound: ${prevId}`)
    await q(`UPDATE authoritative_facts SET status = 'SUPERSEDED' WHERE id = $1`, [prevId])
    const rows = (
      await q(
        `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, supersedes_id, valid_from, valid_until, source_kind) VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,$8,$9,'MANUAL') RETURNING *`,
        [businessId, fact.subject, fact.predicate, bridged.value_text, bridged.value_type, Number(prev["version"]) + 1, prevId, fact.valid_from, fact.valid_until],
      )
    ).rows as Record<string, unknown>[]
    const row = rows[0]!
    await q(
      `INSERT INTO repository_fact_provenance (fact_id, business_id, manifest_key, manifest_digest, source_revision, synced_at, writer, source_url) VALUES ($1,$2,$3,$4,$5,$6,'REPOSITORY_MANIFEST',$7)`,
      [String(row["id"]), businessId, provenance.manifest_key, provenance.manifest_digest, provenance.source_revision, provenance.synced_at, fact.source_url],
    )
    return { ...toSynced(row, provenance.manifest_key), source_url: fact.source_url }
  },
  reactivate: async (businessId: string, prevId: string, fact: ManifestFactV1, bridged: { value_text: string; value_type: string }, provenance: Provenance) => {
    // Continue a retired lineage WITHOUT touching the old row's RETIRED
    // status: the new ACTIVE version links via supersedes_id, so history
    // shows v1 RETIRED -> v2 ACTIVE with exactly one ACTIVE head.
    const prev = (await q(`SELECT * FROM authoritative_facts WHERE id = $1 AND business_id = $2`, [prevId, businessId])).rows[0] as Record<string, unknown> | undefined
    if (!prev) throw new Error(`FactNotFound: ${prevId}`)
    const rows = (
      await q(
        `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, supersedes_id, valid_from, valid_until, source_kind) VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,$8,$9,'MANUAL') RETURNING *`,
        [businessId, fact.subject, fact.predicate, bridged.value_text, bridged.value_type, Number(prev["version"]) + 1, prevId, fact.valid_from, fact.valid_until],
      )
    ).rows as Record<string, unknown>[]
    const row = rows[0]!
    await q(
      `INSERT INTO repository_fact_provenance (fact_id, business_id, manifest_key, manifest_digest, source_revision, synced_at, writer, source_url) VALUES ($1,$2,$3,$4,$5,$6,'REPOSITORY_MANIFEST',$7)`,
      [String(row["id"]), businessId, provenance.manifest_key, provenance.manifest_digest, provenance.source_revision, provenance.synced_at, fact.source_url],
    )
    return { ...toSynced(row, provenance.manifest_key), source_url: fact.source_url }
  },
  retire: async (businessId: string, factId: string) => {
    await q(`UPDATE authoritative_facts SET status = 'RETIRED' WHERE id = $1 AND business_id = $2`, [factId, businessId])
  },
})

export const pgSyncStore = (databaseUrl: string): PgSyncStore => {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const query = async (text: string, params: unknown[] = []) => pool.query(text, params as never[])

  return {
    mode: async (businessId) => txOps(async (text, params = []) => query(text, params)).mode(businessId),
    factCount: async (businessId) => txOps(async (text, params = []) => query(text, params)).factCount(businessId),
    setMode: async (businessId, mode) => {
      await txOps(async (text, params = []) => query(text, params)).setMode(businessId, mode)
    },
    transact: async <T>(businessId: string, fn: (tx: FactTxStore) => Promise<T>): Promise<T> => {
      // One manifest sync = one transaction, serialized per business.
      // The businesses row is stable (FK parent), so locking it orders
      // concurrent syncs without global serialization. Lock lifetime ==
      // transaction lifetime; first-sync mode acquisition happens inside.
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const lock = await client.query(`SELECT id FROM businesses WHERE id = $1 FOR UPDATE`, [businessId])
        if (lock.rows.length === 0) throw new Error(`BusinessNotFound: ${businessId}`)
        await client.query("SET LOCAL ghostping.authority_sync = '1'")
        const q: TxQuery = (text, params = []) => client.query(text, params as never[])
        const out = await fn(txOps(q))
        await client.query("COMMIT")
        return out
      } catch (e) {
        try {
          await client.query("ROLLBACK")
        } catch {
          // ignore rollback errors
        }
        throw e
      } finally {
        client.release()
      }
    },
    close: async () => {
      await pool.end()
    },
  }
}

/** Application-level guard for direct hosted fact mutations (Effect repositories). */
export const assertHostedWritable = async (query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>, businessId: string, op: string): Promise<void> => {
  const r = await query(`SELECT writer FROM business_authority_mode WHERE business_id = $1`, [businessId])
  if ((r.rows[0]?.["writer"] as string | undefined) === "REPOSITORY_MANIFEST") {
    throw new AuthorityError("FactAuthorityManagedByRepository", `${op} ${businessId}`)
  }
}

export const authorityStoreFromPool = (pool: pg.Pool): AuthorityStore => ({
  mode: async (businessId) => {
    const r = await pool.query(`SELECT writer FROM business_authority_mode WHERE business_id = $1`, [businessId])
    const w = (r.rows[0] as Record<string, unknown> | undefined)?.["writer"] as string | undefined
    return w === undefined ? null : (w as "HOSTED" | "REPOSITORY_MANIFEST")
  },
  factCount: async (businessId) => {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM authoritative_facts WHERE business_id = $1`, [businessId])
    return Number((r.rows[0] as Record<string, unknown>)?.["n"] ?? 0)
  },
  setMode: async (businessId, mode) => {
    await pool.query(`INSERT INTO business_authority_mode (business_id, writer) VALUES ($1, $2) ON CONFLICT (business_id) DO UPDATE SET writer = EXCLUDED.writer, set_at = now()`, [businessId, mode])
  },
})
