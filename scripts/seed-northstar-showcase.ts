// Northstar showcase seed: fills every sidebar section of the demo
// "Northstar Software" business with honest mock-labeled data so the full
// design is visible. Safe to re-run: each part guards on its own sentinel
// (observations are append-only and cannot be wiped).
// Run: DATABASE_URL=... pnpm --filter @openrecord/worker exec tsx ../../scripts/seed-northstar-showcase.ts
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
      `SELECT b.id, b.account_id FROM businesses b JOIN account_users au ON au.account_id = b.account_id
       JOIN users u ON u.id = au.user_id WHERE u.email = $1 AND b.name = $2 LIMIT 1`,
      [EMAIL, BUSINESS],
    )
    if (biz.rows.length === 0) throw new Error("Northstar Software not found for demo@northstar.test")
    const businessId = biz.rows[0]["id"] as string
    const userId: string = (await db.query(`SELECT id FROM users WHERE email = $1`, [EMAIL])).rows[0]["id"] as string
    console.log(`business ${businessId}`)

    await seedJudgments(db, businessId)
    await seedCitations(db, businessId)
    await seedFailedRun(db, businessId)
    await seedAssay(db, businessId, userId)
    await seedRecord(db, businessId, userId)
    await seedSite(db, businessId)
    console.log("northstar showcase ready")
  } finally {
    await db.end()
  }
}

// --- 1. Reviewer judgments across verdicts and time (unlocks accuracy) ---
async function seedJudgments(db: pg.Client, businessId: string): Promise<void> {
  const done = await db.query(`SELECT 1 FROM human_judgments j JOIN candidate_claims c ON c.id = j.claim_id WHERE c.business_id = $1 AND j.notes = 'northstar-showcase' LIMIT 1`, [businessId])
  if (done.rows.length > 0) {
    console.log("skip judgments (already seeded)")
    return
  }
  const facts = (await db.query(`SELECT id FROM authoritative_facts WHERE business_id = $1 ORDER BY created_at`, [businessId])).rows.map((r) => r["id"] as string)
  if (facts.length === 0) throw new Error("no facts for judgments")
  const claims = (
    await db.query(
      `SELECT c.id, c.business_id FROM candidate_claims c JOIN observations o ON o.id = c.observation_id
       WHERE c.business_id = $1 AND NOT EXISTS (SELECT 1 FROM human_judgments j WHERE j.claim_id = c.id)
       ORDER BY o.collected_at`,
      [businessId],
    )
  ).rows as Array<{ id: string }>
  const step = Math.max(1, Math.floor(claims.length / 150))
  const picked = claims.filter((_, i) => i % step === 0).slice(0, 160)
  const verdicts = ["SUPPORTED", "SUPPORTED", "SUPPORTED", "SUPPORTED", "CONTRADICTED", "CONTRADICTED", "PARTIAL", "PARTIAL", "INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE"]
  let n = 0
  for (const [i, claim] of picked.entries()) {
    const verdict = verdicts[i % verdicts.length]!
    const jid: string = (await db.query(
      `INSERT INTO human_judgments (business_id, claim_id, verdict, notes) VALUES ($1,$2,$3,'northstar-showcase') RETURNING id`,
      [businessId, claim.id, verdict],
    )).rows[0]["id"] as string
    await db.query(`INSERT INTO human_judgment_facts (judgment_id, fact_id) VALUES ($1,$2)`, [jid, facts[i % facts.length]])
    n++
  }
  console.log(`judgments: ${n} across ${claims.length} unreviewed claims`)
}

// --- 2. Citations across days and providers (unlocks the Citations card) ---
async function seedCitations(db: pg.Client, businessId: string): Promise<void> {
  const done = await db.query(
    `SELECT 1 FROM observation_citations c JOIN observations o ON o.id = c.observation_id
     WHERE o.business_id = $1 AND c.title LIKE 'Northstar showcase%' LIMIT 1`,
    [businessId],
  )
  if (done.rows.length > 0) {
    console.log("skip citations (already seeded)")
    return
  }
  const obs = (
    await db.query(
      `SELECT o.id FROM observations o WHERE o.business_id = $1
       AND NOT EXISTS (SELECT 1 FROM observation_citations c WHERE c.observation_id = o.id)
       ORDER BY o.collected_at`,
      [businessId],
    )
  ).rows.map((r) => r["id"] as string)
  const step = Math.max(1, Math.floor(obs.length / 90))
  const picked = obs.filter((_, i) => i % step === 0).slice(0, 100)
  const owned = ["https://northstar.example/pricing", "https://northstar.example/docs/integrations", "https://northstar.example/support"]
  let n = 0
  for (const [i, id] of picked.entries()) {
    const u = owned[i % owned.length]!
    await db.query(`INSERT INTO observation_citations (observation_id, uri, title, position, attributed) VALUES ($1,$2,$3,1,true)`,
      [id, u, `Northstar showcase ${new URL(u).pathname}`])
    n++
    if (i % 3 === 0) {
      await db.query(`INSERT INTO observation_citations (observation_id, uri, title, position, attributed) VALUES ($1,$2,$3,2,false)`,
        [id, `https://press.example/northstar-review-${i}`, "Northstar showcase third-party review"])
      n++
    }
  }
  console.log(`citations: ${n} on ${picked.length} answers`)
}

// --- 3. One failed check run (failure state on Checks) ---
async function seedFailedRun(db: pg.Client, businessId: string): Promise<void> {
  const done = await db.query(
    `SELECT 1 FROM check_runs WHERE business_id = $1 AND status = 'FAILED' AND failure_detail_safe = 'northstar-showcase timeout' LIMIT 1`,
    [businessId],
  )
  if (done.rows.length > 0) {
    console.log("skip failed run (already seeded)")
    return
  }
  const q = await db.query(`SELECT id FROM buyer_questions WHERE business_id = $1 ORDER BY created_at LIMIT 1`, [businessId])
  if (q.rows.length === 0) return
  await db.query(
    `INSERT INTO check_runs (business_id, question_id, provider, status, queued_at, started_at, completed_at, failure_class, failure_detail_safe)
     VALUES ($1,$2,'mock','FAILED', now() - interval '5 hours', now() - interval '5 hours', now() - interval '5 hours' + interval '9 seconds','PROVIDER_TIMEOUT','northstar-showcase timeout')`,
    [businessId, q.rows[0]["id"]],
  )
  console.log("failed run: 1")
}

// --- 4. Prospect assay: fetched source, proposed + confirmed facts, samples, finding ---
async function seedAssay(db: pg.Client, businessId: string, userId: string): Promise<void> {
  const done = await db.query(`SELECT id FROM assay_sources WHERE business_id = $1 AND url = 'https://northstar.example/pricing'`, [businessId])
  let sourceId: string
  if (done.rows.length > 0) {
    console.log("skip assay (already seeded)")
    return
  }
  const rawId: string = (await db.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') RETURNING id`, [`northstar-showcase-assay-${Date.now()}`])).rows[0]["id"]
  sourceId = (await db.query(
    `INSERT INTO assay_sources (business_id, url, subject, plan_terms, capability_terms, requested_by, status, fetched_at, final_url, raw_evidence_id, fetched_text, extractor_version)
     VALUES ($1,'https://northstar.example/pricing','Northstar Software','[]','[]',$2,'FETCHED', now() - interval '10 days','https://northstar.example/pricing',$3,'Northstar plans start at $39 per month.','assay-extract/1') RETURNING id`,
    [businessId, userId, rawId],
  )).rows[0]["id"] as string
  // One fact awaiting confirmation.
  await db.query(
    `INSERT INTO assay_proposed_facts (business_id, source_id, source_url, fact_type, subject, normalized, supporting_span, extractor_version)
     VALUES ($1,$2,'https://northstar.example/pricing','BOOLEAN_CAPABILITY','Northstar Software','{"capability":"sso"}','Single sign-on included','assay-extract/1')`,
    [businessId, sourceId],
  )
  // One confirmed fact with samples and an unreviewed finding.
  const factId: string = (await db.query(
    `INSERT INTO assay_proposed_facts (business_id, source_id, source_url, fact_type, subject, normalized, supporting_span, extractor_version)
     VALUES ($1,$2,'https://northstar.example/pricing','PRICE','Northstar Software','{"amountMinor":3900,"currency":"USD"}','$39 per month','assay-extract/1') RETURNING id`,
    [businessId, sourceId],
  )).rows[0]["id"] as string
  await db.query(`UPDATE assay_proposed_facts SET status = 'CONFIRMED', reviewed_by = $2, review_reason = 'Northstar showcase: price visible on pricing page.' WHERE id = $1`, [factId, userId])
  const q = await db.query(`SELECT id, prompt FROM buyer_questions WHERE business_id = $1 ORDER BY created_at LIMIT 1`, [businessId])
  const questionId = q.rows[0]["id"] as string
  // The orphaned empty group from the first attempt is reused for samples.
  const groupId: string = (await db.query(`SELECT id FROM assay_sample_groups WHERE business_id = $1 AND status = 'SUCCEEDED' ORDER BY created_at LIMIT 1`, [businessId])).rows[0]?.["id"] as string ?? (await db.query(
    `INSERT INTO assay_sample_groups (business_id, question_id, provider, requested_model, retrieval_mode, n, status)
     VALUES ($1,$2,'mock','mock-1','NONE',5,'QUEUED') RETURNING id`,
    [businessId, questionId],
  )).rows[0]["id"] as string
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
    // Samples start QUEUED: the guard requires the observation to exist
    // before a sample may finish.
    const runId: string = (await db.query(
      `INSERT INTO check_runs (business_id, question_id, provider, requested_model, status, queued_at, started_at, assay_sample_group_id, sample_number)
       VALUES ($1,$2,'mock','mock-1','QUEUED', now() - interval '9 days' + ($3 || ' hours')::interval, now() - interval '9 days' + ($3 || ' hours')::interval, $4, $5) RETURNING id`,
      [businessId, questionId, String(i * 7), groupId, i + 1],
    )).rows[0]["id"] as string
    const obsId: string = (await db.query(
      `INSERT INTO observations (business_id, check_run_id, provider, observed_model, collected_at, answer_text, retrieval_mode, raw_evidence_id, raw_digest)
       VALUES ($1,$2,'mock','mock-1', now() - interval '9 days' + ($3 || ' hours')::interval, $4,'unknown',$5,$6) RETURNING id`,
      [businessId, runId, String(i * 7), answers[i], rawId, `northstar-showcase-assay-${i}`],
    )).rows[0]["id"] as string
    await db.query(`UPDATE check_runs SET status = 'SUCCEEDED', completed_at = started_at + interval '20 seconds' WHERE id = $1`, [runId])
    await db.query(
      `INSERT INTO assay_sample_judgments (business_id, observation_id, proposed_fact_id, comparison, supporting_span, extractor_kind, extractor_version, structured_output)
       VALUES ($1,$2,$3,$4,$5,'DETERMINISTIC','assay-extract/1','{"parsedMoney":null}')`,
      [businessId, obsId, factId, comparisons[i], spans[i]],
    )
  }
  await db.query(`UPDATE assay_sample_groups SET status = 'SUCCEEDED' WHERE id = $1`, [groupId])
  await db.query(
    `INSERT INTO assay_findings (business_id, sample_group_id, proposed_fact_id, sample_count, requested_n, contradict_count, unclear_count, verdict, supporting_spans, retrieval_class, verification_eligible, source_diagnosis)
     VALUES ($1,$2,$3,5,5,3,0,'CONFIRMED','["$49 per month"]','UNKNOWN',false,'{}')`,
    [businessId, groupId, factId],
  )
  console.log("assay: 1 source, 1 proposed fact, 1 confirmed fact, 5 samples, 1 finding")
}

// --- 5. Client record with a derived before/after outcome per slot ---
async function seedRecord(db: pg.Client, businessId: string, userId: string): Promise<void> {
  const profile = await db.query(`SELECT business_id FROM record_profiles WHERE business_id = $1`, [businessId])
  if (profile.rows.length > 0) {
    console.log("skip record (already seeded)")
    return
  }
  const facts = (await db.query(
    `SELECT id, predicate, value_text FROM authoritative_facts WHERE business_id = $1 AND status = 'ACTIVE' ORDER BY created_at LIMIT 3`, [businessId])).rows as Array<{ id: string; predicate: string; value_text: string }>
  const questions = (await db.query(`SELECT id, prompt FROM buyer_questions WHERE business_id = $1 ORDER BY created_at LIMIT 3`, [businessId])).rows as Array<{ id: string; prompt: string }>
  if (facts.length < 3 || questions.length < 3) throw new Error("need 3 facts and 3 questions for the record")
  await db.query(`INSERT INTO record_profiles (business_id, website_url, engagement) VALUES ($1,'https://northstar.example/','CLIENT')`, [businessId])
  const itemIds: string[] = []
  for (let s = 0; s < 3; s++) {
    const itemId: string = (await db.query(
      `INSERT INTO record_items (business_id, slot, fact_id, question_id, source_url, created_by_user_id)
       VALUES ($1,$2,$3,$4,'https://northstar.example/pricing',$5) RETURNING id`,
      [businessId, s + 1, facts[s]!.id, questions[s]!.id, userId],
    )).rows[0]["id"] as string
    await db.query(`INSERT INTO record_item_approvals (item_id, business_id, approved_by_user_id) VALUES ($1,$2,$3)`, [itemId, businessId, userId])
    itemIds.push(itemId)
  }
  // Slot plan: 1 corrects (wrong -> right), 2 stays wrong, 3 already matched.
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
  const decisions = [
    ["CONTRADICTS", "MATCHES"],
    ["CONTRADICTS", "CONTRADICTS"],
    ["MATCHES", "MATCHES"],
  ] as const
  const initialId: string = (await db.query(
    `INSERT INTO record_runs (business_id, kind, provider, requested_model, requested_by_user_id, created_at)
     VALUES ($1,'INITIAL','mock','mock-1',$2, now() - interval '7 days') RETURNING id`, [businessId, userId])).rows[0]["id"] as string
  const followId: string = (await db.query(
    `INSERT INTO record_runs (business_id, kind, baseline_run_id, provider, requested_model, requested_by_user_id, created_at)
     VALUES ($1,'FOLLOW_UP',$2,'mock','mock-1',$3, now() - interval '1 day') RETURNING id`, [businessId, initialId, userId])).rows[0]["id"] as string
  const ctx = (questionId: string, prompt: string, at: string) => ({
    schema: "openrecord/measurement-context-v1",
    schema_version: 1,
    question: prompt,
    question_id: questionId,
    question_version: { state: "KNOWN", value: "northstar-showcase-v1" },
    business_id: businessId,
    surface: {
      schema: "openrecord/surface-v1", schema_version: 1, kind: "MOCK", adapter: "openrecord-mock", adapter_version: "1",
      product: "OpenRecord deterministic fixture", requested_provider: { state: "KNOWN", value: "mock" },
      observed_provider: { state: "KNOWN", value: "mock" }, requested_model: { state: "NOT_APPLICABLE" },
      observed_model: { state: "NOT_APPLICABLE" }, account_state: { state: "NOT_APPLICABLE" },
      subscription_tier: { state: "NOT_APPLICABLE" }, locale: { state: "NOT_APPLICABLE" }, region: { state: "NOT_APPLICABLE" },
      search_mode: { state: "NOT_APPLICABLE" }, personalization_state: { state: "NOT_APPLICABLE" }, metadata_visibility: "FULL",
    },
    observed_at: at,
    measurement_configuration: { state: "KNOWN", value: { deterministic_fixture: true } },
    sample_number: 1,
    repeat_id: { state: "KNOWN", value: randomBytes(16).toString("hex") },
  })
  for (let s = 0; s < 3; s++) {
    for (let r = 0; r < 2; r++) {
      const runId = r === 0 ? initialId : followId
      const at = r === 0 ? "7 days" : "1 day"
      const checkId: string = (await db.query(
        `INSERT INTO check_runs (business_id, question_id, provider, requested_model, status, queued_at, started_at, completed_at, record_run_id, record_item_id)
         VALUES ($1,$2,'mock','mock-1','SUCCEEDED', now() - interval '${at}', now() - interval '${at}', now() - interval '${at}' + interval '25 seconds', $3, $4) RETURNING id`,
        [businessId, questions[s]!.id, runId, itemIds[s]],
      )).rows[0]["id"] as string
      const iso = new Date(Date.now() - (r === 0 ? 7 : 1) * 86400000).toISOString()
      const obsId: string = (await db.query(
        `INSERT INTO observations (business_id, check_run_id, provider, observed_model, collected_at, answer_text, retrieval_mode, retrieval_tool, request_parameters, raw_evidence_id, raw_digest, synthetic, measurement_context)
         VALUES ($1,$2,'mock','mock-1', now() - interval '${at}', $3,'grounded','google_search','{"tools":[{"name":"google_search"}]}',$4,$5,false,$6) RETURNING id`,
        [businessId, checkId, r === 0 ? before[s]! : after[s]!, (await db.query(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') RETURNING id`, [`northstar-showcase-record-${s}-${r}`])).rows[0]["id"], `northstar-showcase-record-${s}-${r}`, JSON.stringify(ctx(questions[s]!.id, questions[s]!.prompt, iso))],
      )).rows[0]["id"] as string
      await db.query(
        `INSERT INTO record_judgments (business_id, observation_id, item_id, decision, note, reviewed_by_user_id)
         VALUES ($1,$2,$3,$4,'northstar showcase',$5)`, [businessId, obsId, itemIds[s], decisions[s]![r], userId])
    }
  }
  const actionId: string = (await db.query(
    `INSERT INTO interventions (business_id, type, target, performed_at, actor, actor_id, notes)
     VALUES ($1,'SOURCE_UPDATED','https://northstar.example/pricing', now() - interval '3 days','HUMAN',$2,'Updated the pricing page to show the approved $39 monthly price.') RETURNING id`,
    [businessId, userId],
  )).rows[0]["id"] as string
  await db.query(`INSERT INTO record_actions (intervention_id, business_id, slot, links) VALUES ($1,$2,1,'[]')`, [actionId, businessId])
  await db.query(`INSERT INTO record_shares (business_id, public_id, status, created_by_user_id) VALUES ($1,$2,'ACTIVE',$3)`,
    [businessId, randomBytes(32).toString("base64url"), userId])
  console.log("record: 3 slots, initial + follow-up runs, 1 action, share active")
}

// --- 6. Site operator target with findings across states ---
async function seedSite(db: pg.Client, businessId: string): Promise<void> {
  const existing = await db.query(`SELECT id FROM site_targets WHERE business_id = $1`, [businessId])
  if (existing.rows.length > 0) {
    console.log("skip site (already seeded)")
    return
  }
  const siteId: string = (await db.query(
    `INSERT INTO site_targets (business_id, root_url, canonical_origin, path_prefix, adapter_kind) VALUES ($1,'https://northstar.example/','https://northstar.example','/','LOCAL_FILE') RETURNING id`,
    [businessId],
  )).rows[0]["id"] as string
  const runId: string = (await db.query(
    `INSERT INTO site_inspection_runs (business_id, site_target_id, state, queued_at, started_at, completed_at, heartbeat_at, attempt_count, urls_inspected)
     VALUES ($1,$2,'SUCCEEDED', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days' + interval '4 minutes', now() - interval '2 days' + interval '4 minutes', 1, 14) RETURNING id`,
    [businessId, siteId],
  )).rows[0]["id"] as string
  const findings = [
    { kind: "MISSING_DESCRIPTION", severity: "HIGH", category: "SEARCH_PRESENTATION", status: "OPEN", url: "https://northstar.example/pricing", diagnosis: "Pricing page has no meta description.", action: "Add a unique meta description under 160 characters." },
    { kind: "BLOCKED_BY_META", severity: "CRITICAL", category: "CRAWL_INDEX_RISK", status: "AWAITING_APPROVAL", url: "https://northstar.example/internal", diagnosis: "Internal docs page carries a noindex tag.", action: "Remove the noindex meta tag." },
    { kind: "MISSING_ALT", severity: "LOW", category: "USABILITY_ACCESSIBILITY", status: "FIX_APPLIED", url: "https://northstar.example/", diagnosis: "Hero image is missing alt text.", action: "Add descriptive alt text." },
    { kind: "MISSING_TITLE", severity: "MEDIUM", category: "SEARCH_PRESENTATION", status: "VERIFIED_FIXED", url: "https://northstar.example/support", diagnosis: "Support page title was empty.", action: "Set the page title." },
  ] as const
  for (const [i, f] of findings.entries()) {
    const fid: string = (await db.query(
      `INSERT INTO site_findings (business_id, site_target_id, run_id, url, canonical_url, finding_kind, severity, category, status, detected_at, evidence, diagnosis, recommended_action, confidence, identity_key)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8, now() - interval '2 days', '{}',$9,$10,'HIGH',$11) RETURNING id`,
      [businessId, siteId, runId, f.url, f.kind, f.severity, f.category, f.status, f.diagnosis, f.action, `northstar-showcase-${i}`],
    )).rows[0]["id"] as string
    await db.query(`INSERT INTO site_finding_events (business_id, finding_id, run_id, from_status, to_status, actor, detail) VALUES ($1,$2,$3,null,$4,'SYSTEM','northstar showcase detection')`,
      [businessId, fid, runId, f.status])
    if (f.status === "AWAITING_APPROVAL") {
      await db.query(
        `INSERT INTO site_fix_proposals (business_id, finding_id, fix_kind, target, file_path, before_text, after_text, patch, rationale, risk, classification)
         VALUES ($1,$2,'MANUAL_ONLY',$3,'internal.html','<meta name="robots" content="noindex">','<!-- noindex removed -->','northstar-showcase-patch','Allow indexing of the internal docs page.','Low: page is already linked from support.','APPROVAL_REQUIRED')`,
        [businessId, fid, f.url])
    }
  }
  console.log("site: 1 target, 1 run, 4 findings")
}

void main()
