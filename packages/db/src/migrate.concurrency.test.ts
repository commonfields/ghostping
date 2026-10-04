// Regression test for the transient first-migrate DDL race: concurrent
// migrate() calls against one database must all succeed. Postgres DDL
// guards (CREATE TABLE IF NOT EXISTS, DROP TRIGGER + CREATE TRIGGER,
// CREATE EXTENSION ...) are check-then-create, not atomic, so
// unsynchronized runners race on the catalog (23505
// pg_type_typname_nsp_index, duplicate trigger/index errors) with exactly
// one winner. migrate() serializes the batch via a session-level advisory
// lock; this test pins that by racing several migrate() calls in one
// process (each opens its own client, equivalent to separate processes
// from the server's perspective). Requires DATABASE_URL (skipped
// otherwise, like the other DB tests).
import { describe, expect, it } from "vitest"
import pg from "pg"
import { migrate } from "./migrate.js"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const run = url ? describe : describe.skip

run("migrate concurrency", () => {
  it("6 concurrent migrate() calls all succeed and leave a complete schema", async () => {
    await Promise.all(Array.from({ length: 6 }, () => migrate(url)))
    const pool = new pg.Pool({ connectionString: url })
    try {
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('users','accounts','businesses','authoritative_facts','buyer_questions','check_runs','observations','raw_evidence','candidate_claims','human_judgments','interventions','reobservations','discovery_runs','discovery_matches','provider_attempt_evidence')`,
      )
      expect(tables.rows.length).toBe(15)
      const triggers = await pool.query(
        `SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_observations_no_update','trg_raw_evidence_no_update','trg_human_judgments_no_update','trg_human_judgment_facts_no_update','trg_observation_citations_no_update')`,
      )
      expect(triggers.rows.length).toBe(5)
      // No leaked session locks: every migrate() released the batch lock.
      const locks = await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`)
      expect(Number(locks.rows[0]["n"])).toBe(0)
    } finally {
      await pool.end()
    }
  })
})
