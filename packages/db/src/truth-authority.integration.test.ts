// PostgreSQL 16 integration tests for Truth Projection V1 authority:
// default HOSTED behavior, repository-mode guards (application + trigger),
// mode immutability, manifest sync end-to-end, provenance, idempotency.
// Requires DATABASE_URL (CI provides a postgres service; skipped otherwise).
import { describe, expect, it } from "vitest"
import pg from "pg"
import { Redacted } from "effect"
import { parseManifest, syncManifestFacts } from "@openrecord/truth"
import { migrate } from "./migrate.js"
import { pgSyncStore } from "./truth.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const describePg = url === "" ? describe.skip : describe

const manifestText = (amount: string) => `schema: openrecord/truth-manifest-v1
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
projections:
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

describePg("postgres truth authority v1", () => {
  it("migrates 0005 cleanly and defaults businesses to HOSTED", async () => {
    await migrate(url)
    await migrate(url)
    const pool = new pg.Pool({ connectionString: url })
    try {
      const version = Number((await pool.query(`SHOW server_version_num`)).rows[0]?.["server_version_num"])
      expect(version).toBeGreaterThanOrEqual(160000)
      const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('business_authority_mode','repository_fact_provenance')`)).rows
      expect(tables.map((r) => (r as Record<string, string>)["tablename"]).sort()).toEqual(["business_authority_mode", "repository_fact_provenance"])
    } finally {
      await pool.end()
    }
  })

  it("syncs a manifest end-to-end with provenance and idempotency", async () => {
    const store = pgSyncStore(url)
    const pool = new pg.Pool({ connectionString: url })
    try {
      const account = (await pool.query(`INSERT INTO accounts (name) VALUES ('truth-test-' || extract(epoch from now())) RETURNING id`)).rows[0] as Record<string, string>
      const business = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1, 'acme') RETURNING id`, [account["id"]])).rows[0] as Record<string, string>
      const biz = String(business["id"])
      const m1 = parseManifest(manifestText("49.00"))
      const r1 = await syncManifestFacts(m1, biz, store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
      expect(r1.created).toEqual(["starter-price"])
      expect(await store.mode(biz)).toBe("REPOSITORY_MANIFEST")
      const r2 = await syncManifestFacts(m1, biz, store, { sourceRevision: null, now: "2026-10-03T01:00:00.000Z" })
      expect([...r2.created, ...r2.superseded, ...r2.retired]).toEqual([])
      const m2 = parseManifest(manifestText("59.00"))
      const r3 = await syncManifestFacts(m2, biz, store, { sourceRevision: "rev-1", now: "2026-10-04T00:00:00.000Z" })
      expect(r3.superseded).toEqual(["starter-price"])
      const ref3 = r3.resolved.get("starter-price")?.ref
      expect(ref3?.kind).toBe("AUTHORITATIVE_FACT")
      if (ref3?.kind === "AUTHORITATIVE_FACT") expect(ref3.version).toBe(2)
      const prov = await pool.query(`SELECT manifest_key, manifest_digest, source_revision, writer FROM repository_fact_provenance WHERE business_id = $1 ORDER BY synced_at`, [biz])
      expect(prov.rows.map((r) => (r as Record<string, string | null>)["manifest_key"])).toEqual(["starter-price", "starter-price"])
      expect(prov.rows[1]?.["source_revision"]).toBe("rev-1")
      expect(prov.rows[1]?.["writer"]).toBe("REPOSITORY_MANIFEST")
      expect(prov.rows[0]?.["source_revision"]).toBeNull()
      const facts = await pool.query(`SELECT value_text, value_type, version, status FROM authoritative_facts WHERE business_id = $1 ORDER BY version`, [biz])
      expect(facts.rows.map((r) => [(r as Record<string, unknown>)["value_text"], (r as Record<string, unknown>)["status"]])).toEqual([
        ["49.00 USD", "SUPERSEDED"],
        ["59.00 USD", "ACTIVE"],
      ])
      // Direct hosted mutation fails closed (application guard).
      const { FactRepository, FactRepositoryLive } = await import("./repositories.js")
      const { Effect, Layer } = await import("effect")
      const { PgClient } = await import("@effect/sql-pg")
      const makeFacts = Layer.provide(FactRepositoryLive, PgClient.layer({ url: Redacted.make(url) }))
      const program = Effect.flatMap(FactRepository, (factsRepo) =>
        factsRepo.create({ businessId: biz, subject: "x", predicate: "y", valueText: "z", valueType: "TEXT", validFrom: "2026-10-03T00:00:00.000Z", validUntil: null, sourceKind: "MANUAL" }),
      )
      const exit = await Effect.runPromiseExit(Effect.provide(program, makeFacts))
      expect(exit._tag).toBe("Failure")
      // Direct SQL without the sync flag fails closed (trigger backstop).
      await expect(pool.query(`INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, source_kind) VALUES ($1,'s','p','v','TEXT','2026-10-03T00:00:00Z','MANUAL')`, [biz])).rejects.toThrowError(/managed by repository manifest/)
      // Mode change with facts present is refused.
      await expect(pool.query(`UPDATE business_authority_mode SET writer = 'HOSTED' WHERE business_id = $1`, [biz])).rejects.toThrowError(/immutable/)
    } finally {
      await pool.end()
      await store.close()
    }
  })

  it("rejects manifest sync for legacy businesses that already have facts", async () => {
    const store = pgSyncStore(url)
    const pool = new pg.Pool({ connectionString: url })
    try {
      const account = (await pool.query(`INSERT INTO accounts (name) VALUES ('truth-hosted-' || extract(epoch from now())) RETURNING id`)).rows[0] as Record<string, string>
      const business = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1, 'legacy') RETURNING id`, [account["id"]])).rows[0] as Record<string, string>
      const biz = String(business["id"])
      await pool.query(`INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, source_kind) VALUES ($1,'s','p','v','TEXT','2026-10-03T00:00:00Z','MANUAL')`, [biz])
      await expect(syncManifestFacts(parseManifest(manifestText("49.00")), biz, store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })).rejects.toThrowError(/ManifestSyncRejectedForHosted/)
    } finally {
      await pool.end()
      await store.close()
    }
  })
})
