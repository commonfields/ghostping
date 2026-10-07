// PostgreSQL 16 closeout tests for Truth Projection V1:
// whole-manifest atomicity (rollback injection, concurrent identical and
// conflicting syncs, single ACTIVE lineage), delete integrity (repository
// direct-delete rejection, provenance survival, parent cascade, HOSTED
// unchanged). Requires DATABASE_URL (CI postgres service; skipped otherwise).
import { describe, expect, it } from "vitest"
import pg from "pg"
import { parseManifest, syncManifestFacts } from "@openrecord/truth"
import type { FactSyncStore } from "@openrecord/truth"
import { pgSyncStore } from "./truth.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const describePg = url === "" ? describe.skip : describe

const manifestText = (amount: string, extra = "") => `schema: openrecord/truth-manifest-v1
business:
  key: acme
authority:
  mode: repository
facts:
  starter-price:
    subject: plan:starter
    predicate: price
    type: money
    value:
      amount: "${amount}"
      currency: USD
    valid_from: 2026-10-03T00:00:00Z
    source:
      url: https://acme.example/pricing
${extra}projections:
  starter-offer:
    kind: JSON_LD
    output: public/generated/starter-offer.json
    document:
      "@context": https://schema.org
      "@type": Offer
      price:
        fact: starter-price
        component: amount
      priceCurrency:
        fact: starter-price
        component: currency
    verify:
      url: https://acme.example/pricing
      extractor:
        kind: JSON_LD
        selector: offers.price
      comparator: MONEY
`

const secondFact = `  support-plan:
    subject: plan:support
    predicate: price
    type: money
    value:
      amount: "9.00"
      currency: USD
    valid_from: 2026-10-03T00:00:00Z
`

const makeBusiness = async (pool: pg.Pool, suffix: string): Promise<string> => {
  const stamp = `${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const account = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [`closeout-${stamp}`])).rows[0] as Record<string, string>
  const business = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1, $2) RETURNING id`, [account["id"], `biz-${stamp}`])).rows[0] as Record<string, string>
  return String(business["id"])
}

const activeFacts = async (pool: pg.Pool, biz: string) =>
  (await pool.query(`SELECT id, version, status, value_text FROM authoritative_facts WHERE business_id = $1 AND status = 'ACTIVE' ORDER BY version`, [biz])).rows as Array<Record<string, unknown>>

const allFacts = async (pool: pg.Pool, biz: string) =>
  (await pool.query(`SELECT id, version, status, value_text FROM authoritative_facts WHERE business_id = $1 ORDER BY version`, [biz])).rows as Array<Record<string, unknown>>

describePg("postgres truth closeout v1", () => {
  it("mid-sync failure rolls back every mutation including mode acquisition", async () => {
    const pool = new pg.Pool({ connectionString: url })
    const base = pgSyncStore(url)
    try {
      const biz = await makeBusiness(pool, "rollback")
      // Baseline: one synced fact to prove pre-existing history survives.
      await syncManifestFacts(parseManifest(manifestText("49.00")), biz, base, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
      expect((await activeFacts(pool, biz)).length).toBe(1)
      // Evil store: throws while writing the second fact's provenance path.
      const evil: FactSyncStore = {
        ...base,
        transact: <T>(b: string, fn: (tx: Parameters<Parameters<FactSyncStore["transact"]>[1]>[0]) => Promise<T>): Promise<T> =>
          base.transact(b, async (tx) =>
            fn({
              ...tx,
              create: async (...a: Parameters<typeof tx.create>) => {
                if ((a[1] as { key?: string }).key === "support-plan") throw new Error("injected-provenance-failure")
                return tx.create(...a)
              },
            }),
          ),
      }
      await expect(
        syncManifestFacts(parseManifest(manifestText("59.00", secondFact)), biz, evil, { sourceRevision: null, now: "2026-10-04T00:00:00.000Z" }),
      ).rejects.toThrowError(/injected-provenance-failure/)
      // Nothing committed: old active fact unchanged, no new rows, no leaks.
      const after = await allFacts(pool, biz)
      expect(after.map((r) => [r["value_text"], r["status"]])).toEqual([["49.00 USD", "ACTIVE"]])
      const prov = await pool.query(`SELECT count(*)::int AS n FROM repository_fact_provenance WHERE business_id = $1`, [biz])
      expect(Number((prov.rows[0] as Record<string, unknown>)["n"])).toBe(1)
      expect(await base.mode(biz)).toBe("REPOSITORY_MANIFEST")
    } finally {
      await pool.end()
      await base.close()
    }
  })

  it("failed first sync leaves no half-applied mode or facts", async () => {
    const pool = new pg.Pool({ connectionString: url })
    const base = pgSyncStore(url)
    try {
      const biz = await makeBusiness(pool, "firstfail")
      const evil: FactSyncStore = {
        ...base,
        transact: <T>(b: string, fn: (tx: Parameters<Parameters<FactSyncStore["transact"]>[1]>[0]) => Promise<T>): Promise<T> =>
          base.transact(b, async (tx) =>
            fn({
              ...tx,
              create: async () => {
                throw new Error("injected-first-failure")
              },
            }),
          ),
      }
      await expect(syncManifestFacts(parseManifest(manifestText("49.00")), biz, evil, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })).rejects.toThrowError(/injected-first-failure/)
      expect(await base.mode(biz)).toBeNull()
      expect(await allFacts(pool, biz)).toEqual([])
      const prov = await pool.query(`SELECT count(*)::int AS n FROM repository_fact_provenance WHERE business_id = $1`, [biz])
      expect(Number((prov.rows[0] as Record<string, unknown>)["n"])).toBe(0)
    } finally {
      await pool.end()
      await base.close()
    }
  })

  it("concurrent identical first syncs converge on one v1 lineage", async () => {
    const pool = new pg.Pool({ connectionString: url })
    const a = pgSyncStore(url)
    const b = pgSyncStore(url)
    try {
      const biz = await makeBusiness(pool, "race-same")
      const manifest = parseManifest(manifestText("49.00"))
      const [r1, r2] = await Promise.all([
        syncManifestFacts(manifest, biz, a, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" }),
        syncManifestFacts(manifest, biz, b, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" }),
      ])
      void r1
      void r2
      const rows = await allFacts(pool, biz)
      expect(rows.map((r) => [r["version"], r["status"], r["value_text"]])).toEqual([[1, "ACTIVE", "49.00 USD"]])
      const prov = await pool.query(`SELECT count(*)::int AS n FROM repository_fact_provenance WHERE business_id = $1`, [biz])
      expect(Number((prov.rows[0] as Record<string, unknown>)["n"])).toBe(1)
    } finally {
      await pool.end()
      await a.close()
      await b.close()
    }
  })

  it("concurrent conflicting syncs serialize into linear history, never a fork", async () => {
    const pool = new pg.Pool({ connectionString: url })
    const seed = pgSyncStore(url)
    const a = pgSyncStore(url)
    const b = pgSyncStore(url)
    try {
      const biz = await makeBusiness(pool, "race-conflict")
      await syncManifestFacts(parseManifest(manifestText("49.00")), biz, seed, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
      await Promise.all([
        syncManifestFacts(parseManifest(manifestText("59.00")), biz, a, { sourceRevision: null, now: "2026-10-04T00:00:00.000Z" }),
        syncManifestFacts(parseManifest(manifestText("69.00")), biz, b, { sourceRevision: null, now: "2026-10-04T00:00:00.000Z" }),
      ])
      const rows = await allFacts(pool, biz)
      expect(rows.map((r) => r["version"])).toEqual([1, 2, 3])
      expect(rows.map((r) => r["status"])).toEqual(["SUPERSEDED", "SUPERSEDED", "ACTIVE"])
      const active = await activeFacts(pool, biz)
      expect(active.length).toBe(1)
      expect(["59.00 USD", "69.00 USD"]).toContain(active[0]?.["value_text"])
    } finally {
      await pool.end()
      await seed.close()
      await a.close()
      await b.close()
    }
  })

  it("database rejects a second ACTIVE head for one manifest key", async () => {
    const pool = new pg.Pool({ connectionString: url })
    const store = pgSyncStore(url)
    try {
      const biz = await makeBusiness(pool, "fork-guard")
      await syncManifestFacts(parseManifest(manifestText("49.00")), biz, store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
      // Bypass the app layer: hand-insert a rival ACTIVE fact + provenance.
      await expect(
        (async () => {
          const client = await pool.connect()
          try {
            await client.query("BEGIN")
            await client.query("SET LOCAL openrecord.authority_sync = '1'")
            const row = (await client.query(
              `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, valid_from, source_kind) VALUES ($1,'plan:starter','price','99.00 USD','CURRENCY','ACTIVE',99,'2026-10-03T00:00:00Z','MANUAL') RETURNING id`,
              [biz],
            )).rows[0] as Record<string, string>
            await client.query(`INSERT INTO repository_fact_provenance (fact_id, business_id, manifest_key, manifest_digest) VALUES ($1,$2,'starter-price','x')`, [row["id"], biz])
            await client.query("COMMIT")
          } finally {
            client.release()
          }
        })(),
      ).rejects.toThrowError(/duplicate ACTIVE fact/)
    } finally {
      await pool.end()
      await store.close()
    }
  })

  it("repository direct fact DELETE is rejected; fact and provenance survive", async () => {
    const pool = new pg.Pool({ connectionString: url })
    const store = pgSyncStore(url)
    try {
      const biz = await makeBusiness(pool, "nodelete")
      const synced = await syncManifestFacts(parseManifest(manifestText("49.00")), biz, store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
      const ref = synced.resolved.get("starter-price")?.ref
      if (ref?.kind !== "AUTHORITATIVE_FACT") throw new Error("expected synced ref")
      await expect(pool.query(`DELETE FROM authoritative_facts WHERE id = $1`, [ref.fact_id])).rejects.toThrowError(/cannot be directly deleted/)
      await expect(pool.query(`DELETE FROM repository_fact_provenance WHERE fact_id = $1`, [ref.fact_id])).rejects.toThrowError(/append-only/)
      const facts = await allFacts(pool, biz)
      expect(facts.map((r) => [r["value_text"], r["status"]])).toEqual([["49.00 USD", "ACTIVE"]])
      const prov = await pool.query(`SELECT count(*)::int AS n FROM repository_fact_provenance WHERE business_id = $1`, [biz])
      expect(Number((prov.rows[0] as Record<string, unknown>)["n"])).toBe(1)
    } finally {
      await pool.end()
      await store.close()
    }
  })

  it("subject/predicate/source_url changes version; retired keys reactivate linearly", async () => {
    const pool = new pg.Pool({ connectionString: url })
    const store = pgSyncStore(url)
    try {
      const biz = await makeBusiness(pool, "semantic")
      await syncManifestFacts(parseManifest(manifestText("49.00")), biz, store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
      // Same value, changed subject -> new version.
      const subj = manifestText("49.00").replace("subject: plan:starter", "subject: plan:starter-plus")
      const r2 = await syncManifestFacts(parseManifest(subj), biz, store, { sourceRevision: null, now: "2026-10-04T00:00:00.000Z" })
      expect(r2.superseded).toEqual(["starter-price"])
      // Same value, changed predicate -> new version.
      const pred = manifestText("49.00").replace("predicate: price", "predicate: list-price")
      const r3 = await syncManifestFacts(parseManifest(pred), biz, store, { sourceRevision: null, now: "2026-10-05T00:00:00.000Z" })
      expect(r3.superseded).toEqual(["starter-price"])
      // Same value, changed source URL -> new version with persisted provenance.
      const src = manifestText("49.00").replace("https://acme.example/pricing", "https://acme.example/pricing-v2")
      const r4 = await syncManifestFacts(parseManifest(src), biz, store, { sourceRevision: null, now: "2026-10-06T00:00:00.000Z" })
      expect(r4.superseded).toEqual(["starter-price"])
      const provUrl = await pool.query(`SELECT source_url FROM repository_fact_provenance p JOIN authoritative_facts f ON f.id = p.fact_id WHERE p.business_id = $1 AND f.status = 'ACTIVE'`, [biz])
      expect((provUrl.rows[0] as Record<string, unknown>)["source_url"]).toBe("https://acme.example/pricing-v2")
      // Remove the only fact -> retires; re-add -> v2 linked to retired v1... here v5.
      const noFacts = `schema: openrecord/truth-manifest-v1
business:
  key: acme
authority:
  mode: repository
facts: {}
projections: {}
`
      const r5 = await syncManifestFacts(parseManifest(noFacts), biz, store, { sourceRevision: null, now: "2026-10-07T00:00:00.000Z" })
      expect(r5.retired).toEqual(["starter-price"])
      const r6 = await syncManifestFacts(parseManifest(manifestText("49.00")), biz, store, { sourceRevision: null, now: "2026-10-08T00:00:00.000Z" })
      expect(r6.reactivated).toEqual(["starter-price"])
      expect(r6.created).toEqual([])
      const rows = (await pool.query(`SELECT version, status, supersedes_id FROM authoritative_facts WHERE business_id = $1 ORDER BY version`, [biz])).rows as Array<Record<string, unknown>>
      expect(rows.map((r) => [r["version"], r["status"]])).toEqual([[1, "SUPERSEDED"], [2, "SUPERSEDED"], [3, "SUPERSEDED"], [4, "RETIRED"], [5, "ACTIVE"]])
      const v5 = rows[4]!
      const v4id = (await pool.query(`SELECT id FROM authoritative_facts WHERE business_id = $1 AND version = 4`, [biz])).rows[0] as Record<string, string>
      expect(v5["supersedes_id"]).toBe(v4id["id"])
      const active = rows.filter((r) => r["status"] === "ACTIVE")
      expect(active.length).toBe(1)
    } finally {
      await pool.end()
      await store.close()
    }
  })

  it("destroying the owning business still cascades; HOSTED deletes unchanged", async () => {
    const pool = new pg.Pool({ connectionString: url })
    const store = pgSyncStore(url)
    try {
      const biz = await makeBusiness(pool, "cascade")
      await syncManifestFacts(parseManifest(manifestText("49.00")), biz, store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
      await pool.query(`DELETE FROM businesses WHERE id = $1`, [biz])
      expect(await allFacts(pool, biz)).toEqual([])
      expect(await store.mode(biz)).toBeNull()
      // HOSTED business: direct SQL fact DELETE keeps existing semantics.
      const hosted = await makeBusiness(pool, "hosted-del")
      await pool.query(`INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, source_kind) VALUES ($1,'s','p','v','TEXT','2026-10-03T00:00:00Z','MANUAL')`, [hosted])
      const fid = String(((await pool.query(`SELECT id FROM authoritative_facts WHERE business_id = $1`, [hosted])).rows[0] as Record<string, string>)["id"])
      await pool.query(`DELETE FROM authoritative_facts WHERE id = $1`, [fid])
      expect(await allFacts(pool, hosted)).toEqual([])
    } finally {
      await pool.end()
      await store.close()
    }
  })
})
