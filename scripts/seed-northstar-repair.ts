// One-off repair: slot 1 follow-up check + both slot-1 observations/judgments.
import { randomBytes } from "node:crypto"
import pg from "pg"

const url = process.env["DATABASE_URL"]
if (!url) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const B = "eff4fe41-18b1-4c0a-9e86-254ccbff37d1"
const EMAIL = "demo@northstar.test"

async function main(): Promise<void> {
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  try {
    const userId: string = (await db.query(`SELECT id FROM users WHERE email = $1`, [EMAIL])).rows[0]["id"]
    const item = (await db.query(`SELECT id, question_id FROM record_items WHERE business_id = $1 AND slot = 1 AND supersedes_id IS NULL`, [B])).rows[0] as { id: string; question_id: string }
    const prompt: string = (await db.query(`SELECT prompt FROM buyer_questions WHERE id = $1`, [item.question_id])).rows[0]["prompt"]
    const runs = (await db.query(`SELECT id, kind FROM record_runs WHERE business_id = $1 ORDER BY created_at`, [B])).rows as Array<{ id: string; kind: string }>
    const initial = runs.find((r) => r.kind === "INITIAL")!.id
    const follow = runs.find((r) => r.kind === "FOLLOW_UP")!.id
    const ctx = (at: string) => ({
      schema: "openrecord/measurement-context-v1", schema_version: 1, question: prompt, question_id: item.question_id,
      question_version: { state: "KNOWN", value: "northstar-showcase-v1" }, business_id: B,
      surface: {
        schema: "openrecord/surface-v1", schema_version: 1, kind: "MOCK", adapter: "openrecord-mock", adapter_version: "1",
        product: "OpenRecord deterministic fixture", requested_provider: { state: "KNOWN", value: "mock" },
        observed_provider: { state: "KNOWN", value: "mock" }, requested_model: { state: "NOT_APPLICABLE" },
        observed_model: { state: "NOT_APPLICABLE" }, account_state: { state: "NOT_APPLICABLE" },
        subscription_tier: { state: "NOT_APPLICABLE" }, locale: { state: "NOT_APPLICABLE" }, region: { state: "NOT_APPLICABLE" },
        search_mode: { state: "NOT_APPLICABLE" }, personalization_state: { state: "NOT_APPLICABLE" }, metadata_visibility: "FULL",
      },
      observed_at: at, measurement_configuration: { state: "KNOWN", value: { deterministic_fixture: true } },
      sample_number: 1, repeat_id: { state: "KNOWN", value: randomBytes(16).toString("hex") },
    })
    const answers = [
      "Northstar costs $49 per month according to this answer.",
      "Northstar costs $39 per month according to this answer.",
    ]
    const decisions = ["CONTRADICTS", "MATCHES"]
    const existing = (await db.query(`SELECT id, record_run_id FROM check_runs WHERE record_item_id = $1`, [item.id])).rows as Array<{ id: string; record_run_id: string }>
    const need = [
      { run: initial, day: "7 days", answer: answers[0]!, decision: decisions[0]!, check: existing.find((c) => c.record_run_id === initial)?.id ?? null },
      { run: follow, day: "1 day", answer: answers[1]!, decision: decisions[1]!, check: existing.find((c) => c.record_run_id === follow)?.id ?? null },
    ]
    for (const n of need) {
      const iso = new Date(Date.now() - (n.day === "7 days" ? 7 : 1) * 86400000).toISOString()
      let checkId = n.check
      if (!checkId) {
        checkId = (await db.query(
          `INSERT INTO check_runs (business_id, question_id, provider, requested_model, status, queued_at, started_at, completed_at, record_run_id, record_item_id)
           VALUES ($1,$2,'mock','mock-1','SUCCEEDED', now() - interval '${n.day}', now() - interval '${n.day}', now() - interval '${n.day}' + interval '25 seconds', $3, $4) RETURNING id`,
          [B, item.question_id, n.run, item.id],
        )).rows[0]["id"] as string
      }
      const hasObs = await db.query(`SELECT 1 FROM observations WHERE check_run_id = $1`, [checkId])
      if (hasObs.rows.length === 0) {
        const rawId: string = (await db.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') RETURNING id`, [`northstar-showcase-repair-${n.day}`])).rows[0]["id"]
        const obsId: string = (await db.query(
          `INSERT INTO observations (business_id, check_run_id, provider, observed_model, collected_at, answer_text, retrieval_mode, retrieval_tool, request_parameters, raw_evidence_id, raw_digest, synthetic, measurement_context)
           VALUES ($1,$2,'mock','mock-1', now() - interval '${n.day}', $3,'grounded','google_search','{"tools":[{"name":"google_search"}]}',$4,$5,false,$6) RETURNING id`,
          [B, checkId, n.answer, rawId, `northstar-showcase-repair-${n.day}`, JSON.stringify(ctx(iso))],
        )).rows[0]["id"] as string
        await db.query(`INSERT INTO record_judgments (business_id, observation_id, item_id, decision, note, reviewed_by_user_id) VALUES ($1,$2,$3,$4,'northstar showcase',$5)`,
          [B, obsId, item.id, n.decision, userId])
        console.log(`repaired ${n.day}`)
      } else {
        console.log(`exists ${n.day}`)
      }
    }
  } finally {
    await db.end()
  }
}

void main()
