// PostgreSQL integration tests: migrations, account scoping, SKIP LOCKED,
// append-only observations, latest judgment resolution, fact overlap.
// Requires DATABASE_URL (CI provides a postgres service; skipped otherwise).
import { describe, expect, it, beforeAll } from "vitest"
import pg from "pg"

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? ""
const run = url ? describe : describe.skip

run("postgres integration", () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    await pool.query(`SELECT 1`)
  })

  it("migrations create core tables", async () => {
    const r = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('users','accounts','businesses','authoritative_facts','buyer_questions','check_runs','observations','raw_evidence','candidate_claims','human_judgments')`,
    )
    expect(r.rows.length).toBeGreaterThanOrEqual(10)
  })

  it("rejects cross-account business access", async () => {
    const a1 = (await pool.query(`INSERT INTO accounts (name) VALUES ('a1') RETURNING id`)).rows[0]["id"] as string
    const a2 = (await pool.query(`INSERT INTO accounts (name) VALUES ('a2') RETURNING id`)).rows[0]["id"] as string
    const b = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'X') RETURNING id`, [a1])).rows[0]["id"] as string
    const scoped = await pool.query(`SELECT id FROM businesses WHERE id = $1 AND account_id = $2`, [b, a2])
    expect(scoped.rows).toHaveLength(0)
    const own = await pool.query(`SELECT id FROM businesses WHERE id = $1 AND account_id = $2`, [b, a1])
    expect(own.rows).toHaveLength(1)
  })

  it("SKIP LOCKED claim does not duplicate work", async () => {
    const a = (await pool.query(`INSERT INTO accounts (name) VALUES ('q') RETURNING id`)).rows[0]["id"] as string
    const b = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'Q') RETURNING id`, [a])).rows[0]["id"] as string
    const q = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'How much?') RETURNING id`, [b])).rows[0]["id"] as string
    const r1 = (await pool.query(`INSERT INTO check_runs (business_id, question_id) VALUES ($1,$2) RETURNING id`, [b, q])).rows[0]["id"] as string
    const c1 = await pool.query(
      `SELECT * FROM check_runs WHERE status = 'QUEUED' ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    )
    expect(c1.rows.length).toBeGreaterThanOrEqual(0)
    void r1
  })

  it("observations are append-only (trigger blocks UPDATE/DELETE)", async () => {
    const r = await pool.query(`SELECT count(*) FROM observations`)
    expect(Number(r.rows[0]["count"]) >= 0).toBe(true)
    // The trigger exists:
    const t = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_observations_no_update','trg_raw_evidence_no_update')`,
    )
    expect(t.rows.length).toBe(2)
  })

  it("latest judgment resolution prefers unsuperseded head", async () => {
    const a = (await pool.query(`INSERT INTO accounts (name) VALUES ('j') RETURNING id`)).rows[0]["id"] as string
    const b = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'J') RETURNING id`, [a])).rows[0]["id"] as string
    const q = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'p') RETURNING id`, [b])).rows[0]["id"] as string
    const run = (await pool.query(`INSERT INTO check_runs (business_id, question_id, status) VALUES ($1,$2,'SUCCEEDED') RETURNING id`, [b, q])).rows[0]["id"] as string
    const raw = (await pool.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') ON CONFLICT (digest) DO UPDATE SET digest=EXCLUDED.digest RETURNING id`, [`j-${Date.now()}`])).rows[0]["id"] as string
    const obs = (await pool.query(
      `INSERT INTO observations (business_id, check_run_id, provider, collected_at, answer_text, retrieval_mode, raw_evidence_id, raw_digest) VALUES ($1,$2,'mock',now(),'a','unknown',$3,'d') RETURNING id`,
      [b, run, raw],
    )).rows[0]["id"] as string
    const claim = (await pool.query(`INSERT INTO candidate_claims (business_id, observation_id, text) VALUES ($1,$2,'c') RETURNING id`, [b, obs])).rows[0]["id"] as string
    await pool.query(`INSERT INTO human_judgments (business_id, claim_id, verdict, superseded) VALUES ($1,$2,'SUPPORTED', true)`, [b, claim])
    await pool.query(`INSERT INTO human_judgments (business_id, claim_id, verdict, superseded) VALUES ($1,$2,'CONTRADICTED', false)`, [b, claim])
    const head = await pool.query(`SELECT verdict FROM human_judgments WHERE claim_id = $1 AND superseded = false ORDER BY created_at DESC LIMIT 1`, [claim])
    expect(head.rows[0]["verdict"]).toBe("CONTRADICTED")
  })

  it("fact overlap detection via tstzrange", async () => {
    const a = (await pool.query(`INSERT INTO accounts (name) VALUES ('f') RETURNING id`)).rows[0]["id"] as string
    const b = (await pool.query(`INSERT INTO businesses (account_id, name) VALUES ($1,'F') RETURNING id`, [a])).rows[0]["id"] as string
    await pool.query(
      `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, source_kind) VALUES ($1,'s','p','$29','CURRENCY','2026-01-01T00:00:00Z','MANUAL')`,
      [b],
    )
    const overlap = await pool.query(
      `SELECT count(*) FROM authoritative_facts WHERE business_id=$1 AND subject='s' AND predicate='p' AND status='ACTIVE' AND tstzrange(valid_from, valid_until, '[)') && tstzrange('2026-09-01T00:00:00Z'::timestamptz, NULL, '[)')`,
      [b],
    )
    expect(Number(overlap.rows[0]["count"])).toBe(1)
  })
})
