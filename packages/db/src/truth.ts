// Truth Projection V1 persistence (plain node-postgres, like migrate.ts):
// authority modes, repository provenance, manifest-sync store, and the
// verification-bridge store. Runtime imports from representation are
// one-directional (representation never imports db).

import pg from "pg"
import { Schema } from "effect"
import { sameCanonicalUrl } from "@openrecord/representation"
import { AuthorityError, decodeBridge, type AuthorityStore, type BridgeStore, type FactSyncStore, type FactTxStore, type Provenance, type SyncedFact } from "@openrecord/truth"
import type { ManifestFactV1 } from "@openrecord/truth"
import {
  NullableTextField,
  NullableTimestampField,
  TextField,
  TimestampField,
  UuidField,
  IntField,
  RowDecodeError,
} from "./row-codecs.js"

export { AuthorityError }

const iso = (v: unknown): string => new Date(String(v)).toISOString()

const SyncedFactSchema = Schema.Struct({
  id: UuidField,
  version: IntField,
  status: TextField,
  subject: TextField,
  predicate: TextField,
  value_text: TextField,
  value_type: TextField,
  valid_from: TimestampField,
  valid_until: NullableTimestampField,
  source_url: Schema.optional(NullableTextField),
})

const decodeSyncedRow = (row: unknown, table: string) => {
  const result = Schema.decodeUnknownEither(SyncedFactSchema)(row)
  if (result._tag === "Right") return result.right
  let detail: string
  try {
    detail = JSON.stringify(result.left).slice(0, 500)
  } catch {
    detail = String(result.left).slice(0, 500)
  }
  throw new RowDecodeError({ table, detail })
}

const toSynced = (row: Record<string, unknown>, key: string): SyncedFact => {
  const d = decodeSyncedRow(row, "authoritative_facts")
  const decoded = decodeBridge(d.value_text, d.value_type)
  if (!decoded) throw new Error(`NonCanonicalAuthorityValue: ${d.id}`)
  return {
    id: d.id,
    key,
    version: Number(d.version),
    status: d.status as SyncedFact["status"],
    subject: d.subject,
    predicate: d.predicate,
    value: decoded,
    valid_from: iso(d.valid_from),
    valid_until: d.valid_until === null ? null : iso(d.valid_until),
    source_url: d.source_url ?? null,
  }
}

export interface PgSyncStore extends FactSyncStore {
  readonly close: () => Promise<void>
}

type TxQuery = (text: string, params?: unknown[]) => Promise<pg.QueryResult>

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
        await client.query("SET LOCAL openrecord.authority_sync = '1'")
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

/**
 * Verification-bridge store for manifest sync: idempotent target/binding
 * reconciliation with canonical-URL dedupe. Business-scoped; the tenancy
 * triggers reject anything cross-business. Used by the truth sync workflow
 * (never by the browser).
 */
export const pgBridgeStore = (databaseUrl: string, businessId: string): BridgeStore & { close: () => Promise<void> } => {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  return {
    findTargetByUrl: async (canonicalUrl) => {
      const r = await pool.query(`SELECT id, url FROM source_targets WHERE business_id = $1`, [businessId])
      for (const row of r.rows as Array<Record<string, unknown>>) {
        if (sameCanonicalUrl(String(row["url"]), canonicalUrl)) {
          return { id: String(row["id"]), url: String(row["url"]) }
        }
      }
      return null
    },
    createTarget: async (url) => {
      const r = await pool.query(`INSERT INTO source_targets (business_id, url, control, enabled) VALUES ($1, $2, 'OWNED', true) RETURNING id, url`, [businessId, url])
      const row = r.rows[0] as Record<string, unknown>
      return { id: String(row["id"]), url: String(row["url"]) }
    },
    findBinding: async (targetId, factId, extractorKind, selector, comparator) => {
      const r = await pool.query(
        `SELECT id, source_target_id, fact_id, managed_key, created_at FROM source_bindings WHERE business_id = $1 AND source_target_id = $2 AND fact_id = $3 AND extractor_kind = $4 AND extractor_selector = $5 AND comparator = $6 LIMIT 1`,
        [businessId, targetId, factId, extractorKind, selector, comparator],
      )
      const row = (r.rows as Array<Record<string, unknown>>)[0]
      return row ? toBridgeBinding(row) : null
    },
    createBinding: async (targetId, factId, extractorKind, selector, comparator, managedKey = null) => {
      const r = await pool.query(
        `INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator, managed_key) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, source_target_id, fact_id, managed_key, created_at`,
        [businessId, targetId, factId, extractorKind, selector, comparator, managedKey ?? null],
      )
      const row = r.rows[0] as Record<string, unknown>
      return toBridgeBinding(row)
    },
    findManagedBinding: async (managedKey, targetId, extractorKind, selector, comparator) => {
      const r = await pool.query(
        `SELECT id, source_target_id, fact_id, managed_key, created_at FROM source_bindings WHERE business_id = $1 AND managed_key = $2 AND source_target_id = $3 AND extractor_kind = $4 AND extractor_selector = $5 AND comparator = $6 LIMIT 1`,
        [businessId, managedKey, targetId, extractorKind, selector, comparator],
      )
      const row = (r.rows as Array<Record<string, unknown>>)[0]
      return row ? toBridgeBinding(row) : null
    },
    advanceBinding: async (id, factId) => {
      const r = await pool.query(
        `UPDATE source_bindings SET fact_id = $2 WHERE id = $1 AND business_id = $3 RETURNING id, source_target_id, fact_id, managed_key, created_at`,
        [id, factId, businessId],
      )
      const row = (r.rows as Array<Record<string, unknown>>)[0]
      if (!row) throw new Error(`BindingNotFound: ${id}`)
      return toBridgeBinding(row)
    },
    adoptBinding: async (id, managedKey, factId) => {
      const r = await pool.query(
        `UPDATE source_bindings SET managed_key = $2, fact_id = $3 WHERE id = $1 AND business_id = $4 RETURNING id, source_target_id, fact_id, managed_key, created_at`,
        [id, managedKey, factId, businessId],
      )
      const row = (r.rows as Array<Record<string, unknown>>)[0]
      if (!row) throw new Error(`BindingNotFound: ${id}`)
      return toBridgeBinding(row)
    },
    listUnmanagedByDims: async (targetId, extractorKind, selector, comparator) => {
      const r = await pool.query(
        `SELECT b.id, b.source_target_id, b.fact_id, b.managed_key, b.created_at, p.manifest_key AS provenance_key
         FROM source_bindings b LEFT JOIN repository_fact_provenance p ON p.fact_id = b.fact_id
         WHERE b.business_id = $1 AND b.source_target_id = $2 AND b.extractor_kind = $3 AND b.extractor_selector = $4 AND b.comparator = $5 AND b.managed_key IS NULL
         ORDER BY b.created_at ASC`,
        [businessId, targetId, extractorKind, selector, comparator],
      )
      return (r.rows as Array<Record<string, unknown>>).map((row) => ({
        ...toBridgeBinding(row),
        manifestKey: (row["provenance_key"] as string | null) ?? null,
      }))
    },
    close: async () => {
      await pool.end()
    },
  }
}

const BridgeBindingSchema = Schema.Struct({
  id: UuidField,
  source_target_id: UuidField,
  fact_id: UuidField,
  managed_key: NullableTextField,
  created_at: TimestampField,
})

const toBridgeBinding = (row: Record<string, unknown>) => {
  const result = Schema.decodeUnknownEither(BridgeBindingSchema)(row)
  if (result._tag === "Left") {
    let detail: string
    try {
      detail = JSON.stringify(result.left).slice(0, 500)
    } catch {
      detail = String(result.left).slice(0, 500)
    }
    throw new RowDecodeError({ table: "source_bindings", detail })
  }
  const d = result.right
  return {
    id: d.id,
    target_id: d.source_target_id,
    fact_id: d.fact_id,
    managed_key: d.managed_key,
    created_at: String(d.created_at),
  }
}
