// Northstar showcase seed, part 2: assay samples/finding + record
// checks/judgments/action/share. Each section guards on its own sentinel.
// Run: DATABASE_URL=... pnpm --filter @openrecord/worker exec tsx ../../scripts/seed-northstar-showcase-2.ts
import { randomBytes } from "node:crypto"
import pg from "pg"

const url = process.env["DATABASE_URL"]
if (!url) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const BUSINESS = "Northstar Software"
const EMAIL = "demo@northstar.test"

async function main(): Promise<void> {
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  try {
    const biz = await db.query(
      `SELECT b.id FROM businesses b JOIN account_users au ON au.account_id = b.account_id
       JOIN users u ON u.id = au.user_id WHERE u.email = $1 AND b.name = $2 LIMIT 1`,
      [EMAIL, BUSINESS],
    )
    if (biz.rows.length === 0) throw new Error("business not found")
    const businessId = biz.rows[0]["id"] as string
    const userId: string = (await db.query(`SELECT id FROM users WHERE email = $1`, [EMAIL])).rows[0]["id"] as string
    await seedAssayRemainder(db, businessId, userId)
    await seedRecordRemainder(db, businessId, userId)
    console.log("part 2 done")
  } finally {
    await db.end()
  }
}

async function seedAssayRemainder(db: pg.Client, businessId: string, userId: string): Promise<void> {
  const existing = await db.query(`SELECT id FROM assay_findings WHERE business_id = $1`, [businessId])
  if (existing.rows.length > 0) {
    console.log("skip assay remainder (finding exists)")
    return
  }
  // Confirm the PRICE fact (the BOOLEAN one stays proposed).
  const price = await db.query(
    `SELECT id, status FROM assay_proposed_facts WHERE business_id = $1 AND fact_type = 'PRICE' ORDER BY created_at LIMIT 1`, [businessId])
  if (price.rows.length === 0) throw new Error("no PRICE proposed fact")
  const factId = price.rows[0]["id"] as string
  if (price.rows[0]["status"] === "PROPOSED") {
    await db.query(`UPDATE assay_proposed_facts SET status = 'CONFIRMED', reviewed_by = $2, review_reason = 'Northstar showcase: price visible on pricing page.' WHERE id = $1`, [factId, userId])
    console.log("fact confirmed")
  }
  const q = await db.query(`SELECT id FROM buyer_questions WHERE business_id = $1 ORDER BY created_at LIMIT 1`, [businessId])
  const questionId = q.rows[0]["id"] as string
  let group = await db.query(
    `SELECT id FROM assay_sample_groups WHERE business_id = $1 AND question_id = $2 AND provider = 'mock' AND n = 5
     AND NOT EXISTS (SELECT 1 FROM check_runs r WHERE r.assay_sample_group_id = assay_sample_groups.id) LIMIT 1`, [businessId, questionId])
  let groupId: string
  if (group.rows.length > 0) {
    groupId = group.rows[0]["id"] as string
    console.log(`reusing empty group ${groupId}`)
  } else {
    groupId = (await db.query(
      `INSERT INTO assay_sample_groups (business_id, question_id, provider, requested_model, retrieval_mode, n, status)
       VALUES ($1,$2,'mock','mock-1','NONE',5,'QUEUED') RETURNING id`, [businessId, questionId])).rows[0]["id"] as string
    console.log(`new group ${groupId}`)
  }
  const rawId: string = (await db.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') RETURNING id`, [`northstar-showcase-assay-b-${Date.now()}`])).rows[0]["id"]
  const answers = [
    "Northstar costs $49 per month per the latest review.",
    "Northstar costs $39 per month, billed monthly.",
    "Reviewers note Northstar at $49 per month for teams.",
    "Northstar lists $39 per month on its pricing page.",
    "Some posts claim Northstar is $49 per month now.",
  ]
  const spans = ["$49 per month", "$39 per month", "$49 per month", "$39 per month", "$49 per month"]
  const comparisons = ["CONTRADICTS", "MATCHES", "CONTRADICTS", "MATCHES", "CONTRADICTS"]
  for (let i = 0; i < 5; i++) {
    const runId: string = (await db.query(
      `INSERT INTO check_runs (business_id, question_id, provider, requested_model, status, queued_at, started_at, assay_sample_group_id, sample_number)
       VALUES ($1,$2,'mock','mock-1','QUEUED', now() - interval '9 days' + ($3 || ' hours')::interval, now() - interval '9 days' + ($3 || ' hours')::interval, $4, $5) RETURNING id`,
      [businessId, questionId, String(i * 7), groupId, i + 1],
    )).rows[0]["id"] as string
    const obsId: string = (await db.query(
      `INSERT INTO observations (business_id, check_run_id, provider, observed_model, collected_at, answer_text, retrieval_mode, raw_evidence_id, raw_digest)
       VALUES ($1,$2,'mock','mock-1', now() - interval '9 days' + ($3 || ' hours')::interval, $4,'unknown',$5,$6) RETURNING id`,
      [businessId, runId, String(i * 7), answers[i], rawId, `northstar-showcase-assay-b-${i}`],
    )).rows[0]["id"] as string
    await db.query(`UPDATE check_runs SET status = 'SUCCEEDED', completed_at = started_at + interval '20 seconds' WHERE id = $1`, [runId])
    await db.query(
      `INSERT INTO assay_sample_judgments (business_id, observation_id, proposed_fact_id, comparison, supporting_span, extractor_kind, extractor_version, structured_output)
       VALUES ($1,$2,$3,$4,$5,'DETERMINISTIC','assay-extract/1','{"parsedMoney":null}')`,
      [businessId, obsId, factId, comparisons[i], spans[i]],
    )
    console.log(`sample ${i + 1}/5`)
  }
  await db.query(`UPDATE assay_sample_groups SET status = 'SUCCEEDED' WHERE id = $1`, [groupId])
  await db.query(
    `INSERT INTO assay_findings (business_id, sample_group_id, proposed_fact_id, sample_count, requested_n, contradict_count, unclear_count, verdict, supporting_spans, retrieval_class, verification_eligible, source_diagnosis)
     VALUES ($1,$2,$3,5,5,3,0,'CONFIRMED','["$49 per month"]','UNKNOWN',false,'{}')`,
    [businessId, groupId, factId],
  )
  console.log("finding inserted")
}

async function seedRecordRemainder(db: pg.Client, businessId: string, userId: string): Promise<void> {
  const runs = await db.query(`SELECT id, kind FROM record_runs WHERE business_id = $1 ORDER BY created_at`, [businessId])
  if (runs.rows.length === 0) throw new Error("no record runs (part 1 did not finish)")
  const have = await db.query(`SELECT 1 FROM record_shares WHERE business_id = $1 LIMIT 1`, [businessId])
  const checks = await db.query(`SELECT count(*)::int AS n FROM check_runs WHERE business_id = $1 AND record_run_id IS NOT NULL`, [businessId])
  if ((checks.rows[0] as { n: number }).n >= 6 && have.rows.length > 0) {
    console.log("skip record remainder (complete)")
    return
  }
  const items = (await db.query(`SELECT id, question_id FROM record_items WHERE business_id = $1 AND supersedes_id IS NULL ORDER BY slot`, [businessId])).rows as Array<{ id: string; question_id: string }>
  const questions = (await db.query(`SELECT id, prompt FROM buyer_questions WHERE business_id = $1 ORDER BY created_at LIMIT 3`, [businessId])).rows as Array<{ id: string; prompt: string }>
  const qprompt = new Map(questions.map((x) => [x.id, x.prompt]))
  const initial = runs.rows.find((r) => r["kind"] === "INITIAL")!["id"] as string
  const follow = runs.rows.find((r) => r["kind"] === "FOLLOW_UP")!["id"] as string
  const before = [
    "Northstar costs $49 per month according to this answer.",
    "Northstar includes 24/7 phone support for every plan.",
    "Northstar offers 30-day refunds, no questions asked.",
  ]
  const after = [
    "Northstar costs $39 per month according to this answer.",
    "Northstar includes 24/7 phone support for every plan.",
    "Northstar offers 30-day refunds, no questions asked.",
  ]
  const decisions = [["CONTRADICTS", "MATCHES"], ["CONTRADICTS", "CONTRADICTS"], ["MATCHES", "MATCHES"]]
  const ctx = (questionId: string, prompt: string, at: string) => ({
    schema: "openrecord/measurement-context-v1", schema_version: 1, question: prompt, question_id: questionId,
    question_version: { state: "KNOWN", value: "northstar-showcase-v1" }, business_id: businessId,
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
  for (let s = 0; s < items.length; s++) {
    const exists = await db.query(`SELECT 1 FROM check_runs WHERE record_item_id = $1 LIMIT 1`, [items[s]!.id])
    if (exists.rows.length > 0) {
      console.log(`slot ${s + 1} checks exist, skipping`)
      continue
    }
    for (let r = 0; r < 2; r++) {
      const at = r === 0 ? "7 days" : "1 day"
      const checkId: string = (await db.query(
        `INSERT INTO check_runs (business_id, question_id, provider, requested_model, status, queued_at, started_at, completed_at, record_run_id, record_item_id)
         VALUES ($1,$2,'mock','mock-1','SUCCEEDED', now() - interval '${at}', now() - interval '${at}', now() - interval '${at}' + interval '25 seconds', $3, $4) RETURNING id`,
        [businessId, items[s]!.question_id, r === 0 ? initial : follow, items[s]!.id],
      )).rows[0]["id"] as string
      const iso = new Date(Date.now() - (r === 0 ? 7 : 1) * 86400000).toISOString()
      const rawId: string = (await db.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') RETURNING id`, [`northstar-showcase-record2-${s}-${r}`])).rows[0]["id"]
      const obsId: string = (await db.query(
        `INSERT INTO observations (business_id, check_run_id, provider, observed_model, collected_at, answer_text, retrieval_mode, retrieval_tool, request_parameters, raw_evidence_id, raw_digest, synthetic, measurement_context)
         VALUES ($1,$2,'mock','mock-1', now() - interval '${at}', $3,'grounded','google_search','{"tools":[{"name":"google_search"}]}',$4,$5,false,$6) RETURNING id`,
        [businessId, checkId, r === 0 ? before[s]! : after[s]!, rawId, `northstar-showcase-record2-${s}-${r}`, JSON.stringify(ctx(items[s]!.question_id, qprompt.get(items[s]!.question_id) ?? "", iso))],
      )).rows[0]["id"] as string
      await db.query(`INSERT INTO record_judgments (business_id, observation_id, item_id, decision, note, reviewed_by_user_id) VALUES ($1,$2,$3,$4,'northstar showcase',$5)`,
        [businessId, obsId, items[s]!.id, decisions[s]![r], userId])
    }
    console.log(`slot ${s + 1} checks+judgments done`)
  }
  const acts = await db.query(`SELECT 1 FROM record_actions WHERE business_id = $1 LIMIT 1`, [businessId])
  if (acts.rows.length === 0) {
    const actionId: string = (await db.query(
      `INSERT INTO interventions (business_id, type, target, performed_at, actor, actor_id, notes)
       VALUES ($1,'SOURCE_UPDATED','https://northstar.example/pricing', now() - interval '3 days','HUMAN',$2,'Updated the pricing page to show the approved $39 monthly price.') RETURNING id`,
      [businessId, userId],
    )).rows[0]["id"] as string
    await db.query(`INSERT INTO record_actions (intervention_id, business_id, slot, links) VALUES ($1,$2,1,'[]')`, [actionId, businessId])
    console.log("action added")
  }
  if (have.rows.length === 0) {
    await db.query(`INSERT INTO record_shares (business_id, public_id, status, created_by_user_id) VALUES ($1,$2,'ACTIVE',$3)`,
      [businessId, randomBytes(32).toString("base64url"), userId])
    console.log("share active")
  }
}

void main()
