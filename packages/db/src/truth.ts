// Truth Projection V1 persistence (plain node-postgres, like migrate.ts):
// authority modes, repository provenance, and a manifest-sync store that
// runs under SET LOCAL ghostping.authority_sync = '1'. Only type imports
// flow db -> truth, so there is no runtime dependency cycle.

import pg from "pg"
import { AuthorityError, decodeBridge, type AuthorityStore, type FactSyncStore, type Provenance, type SyncedFact } from "@ghostping/truth"
import type { ManifestFactV1 } from "@ghostping/truth"

export { AuthorityError }

const iso = (v: unknown): string => new Date(String(v)).toISOString()

export interface PgSyncStore extends FactSyncStore {
  readonly close: () => Promise<void>
}

const toSynced = (row: Record<string, unknown>, key: string): SyncedFact => {
  const decoded = decodeBridge(String(row["value_text"]), String(row["value_type"]))
  if (!decoded) throw new Error(`NonCanonicalAuthorityValue: ${String(row["id"])}`)
  return {
    id: String(row["id"]),
    key,
    version: Number(row["version"]),
    status: String(row["status"]) as SyncedFact["status"],
    value: decoded,
    valid_from: iso(row["valid_from"]),
    valid_until: row["valid_until"] === null ? null : iso(row["valid_until"]),
  }
}

export const pgSyncStore = (databaseUrl: string): PgSyncStore => {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const query = async (text: string, params: unknown[] = []) => pool.query(text, params as never[])

  const withSyncFlag = async <T>(fn: (q: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL ghostping.authority_sync = '1'")
      const q = (text: string, params: unknown[] = []) => client.query(text, params as never[])
      const out = await fn(q)
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
  }

  return {
    mode: async (businessId) => {
      const r = await query(`SELECT writer FROM business_authority_mode WHERE business_id = $1`, [businessId])
      const w = r.rows[0]?.["writer"] as string | undefined
      return w === undefined ? null : (w as "HOSTED" | "REPOSITORY_MANIFEST")
    },
    factCount: async (businessId) => {
      const r = await query(`SELECT COUNT(*)::int AS n FROM authoritative_facts WHERE business_id = $1`, [businessId])
      return Number(r.rows[0]?.["n"] ?? 0)
    },
    setMode: async (businessId, mode) => {
      await query(
        `INSERT INTO business_authority_mode (business_id, writer) VALUES ($1, $2) ON CONFLICT (business_id) DO UPDATE SET writer = EXCLUDED.writer, set_at = now()`,
        [businessId, mode],
      )
    },
    activeFacts: async (businessId) => {
      const r = await query(
        `SELECT f.*, p.manifest_key FROM authoritative_facts f JOIN repository_fact_provenance p ON p.fact_id = f.id WHERE f.business_id = $1 AND f.status = 'ACTIVE' ORDER BY p.manifest_key`,
        [businessId],
      )
      return (r.rows as Record<string, unknown>[]).map((row) => toSynced(row, String(row["manifest_key"])))
    },
    provenanceKeys: async (businessId) => {
      const r = await query(`SELECT DISTINCT manifest_key FROM repository_fact_provenance WHERE business_id = $1`, [businessId])
      return new Set((r.rows as Record<string, unknown>[]).map((row) => String(row["manifest_key"])))
    },
    create: async (businessId, fact: ManifestFactV1, bridged, provenance: Provenance) =>
      withSyncFlag(async (q) => {
        const rows = (
          await q(
            `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, valid_from, valid_until, source_kind) VALUES ($1,$2,$3,$4,$5,'ACTIVE',1,$6,$7,'MANUAL') RETURNING *`,
            [businessId, fact.subject, fact.predicate, bridged.value_text, bridged.value_type, fact.valid_from, fact.valid_until],
          )
        ).rows as Record<string, unknown>[]
        const row = rows[0]!
        await q(
          `INSERT INTO repository_fact_provenance (fact_id, business_id, manifest_key, manifest_digest, source_revision, synced_at, writer) VALUES ($1,$2,$3,$4,$5,$6,'REPOSITORY_MANIFEST')`,
          [String(row["id"]), businessId, provenance.manifest_key, provenance.manifest_digest, provenance.source_revision, provenance.synced_at],
        )
        return toSynced(row, provenance.manifest_key)
      }),
    supersede: async (businessId, prevId, fact: ManifestFactV1, bridged, provenance: Provenance) =>
      withSyncFlag(async (q) => {
        const prev = (
          await q(`SELECT * FROM authoritative_facts WHERE id = $1 AND business_id = $2`, [prevId, businessId])
        ).rows[0] as Record<string, unknown> | undefined
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
          `INSERT INTO repository_fact_provenance (fact_id, business_id, manifest_key, manifest_digest, source_revision, synced_at, writer) VALUES ($1,$2,$3,$4,$5,$6,'REPOSITORY_MANIFEST')`,
          [String(row["id"]), businessId, provenance.manifest_key, provenance.manifest_digest, provenance.source_revision, provenance.synced_at],
        )
        return toSynced(row, provenance.manifest_key)
      }),
    retire: async (businessId, factId) =>
      withSyncFlag(async (q) => {
        await q(`UPDATE authoritative_facts SET status = 'RETIRED' WHERE id = $1 AND business_id = $2`, [factId, businessId])
      }),
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
