// Demo world seed: one login + five companies showing every Product Surface state.
// Fictional data. Idempotent per company: existing companies are skipped
// (observations are append-only and cannot be wiped).
// Run: DATABASE_URL=... pnpm --filter @ghostping/worker exec tsx ../../scripts/demo-seed.ts
import { randomBytes, scryptSync } from "node:crypto"
import pg from "pg"
import { buildAuthoritySnapshot } from "@ghostping/discovery"

const DEMO_EMAIL = "demo@northstar.test"
const DEMO_PASSWORD = "password123"

const hashPassword = (password: string): string => {
  const salt = randomBytes(16).toString("hex")
  return `scrypt$16384$8$1$${salt}$${scryptSync(password, salt, 32).toString("hex")}`
}

const url = process.env["DATABASE_URL"]
if (!url) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

interface CompanySpec {
  readonly slug: string
  readonly name: string
  readonly domain: string
  readonly priceOld: string
  readonly priceNew: string
  readonly boolValue: "true" | "false"
  readonly boolObserved: string | null
  readonly textValue: string
  readonly textObserved: string | null
  readonly questions: ReadonlyArray<string>
  readonly verdicts: ReadonlyArray<"SUPPORTED" | "CONTRADICTED" | "PARTIAL" | "NEEDS_REVIEW">
  readonly failedCheck: boolean
  readonly discovery: "full" | "current-only" | "historical-stale" | "partial" | "scope-only"
}

const COMPANIES: ReadonlyArray<CompanySpec> = [
  {
    slug: "northstar", name: "Northstar Software", domain: "northstar.example",
    priceOld: "49 USD", priceNew: "39 USD", boolValue: "false", boolObserved: "true",
    textValue: "24 hours", textObserved: null,
    questions: ["How much does Northstar cost?", "Does Northstar integrate with Salesforce?", "What is Northstar's cancellation policy?"],
    verdicts: ["CONTRADICTED", "NEEDS_REVIEW"], failedCheck: false, discovery: "full",
  },
  {
    slug: "acme", name: "Acme Outdoors", domain: "acme.example",
    priceOld: "99 USD", priceNew: "79 USD", boolValue: "true", boolObserved: "true",
    textValue: "30 days", textObserved: "30 days",
    questions: ["How much does Acme cost?", "Does Acme ship internationally?"],
    verdicts: ["SUPPORTED", "SUPPORTED"], failedCheck: false, discovery: "current-only",
  },
  {
    slug: "brightline", name: "Brightline Legal", domain: "brightline.example",
    priceOld: "299 USD", priceNew: "249 USD", boolValue: "false", boolObserved: "yes",
    textValue: "14 days", textObserved: null,
    questions: ["What does Brightline charge?", "Is there a free consultation?"],
    verdicts: ["CONTRADICTED", "NEEDS_REVIEW"], failedCheck: true, discovery: "historical-stale",
  },
  {
    slug: "copperline", name: "Copperline Coffee", domain: "copperline.example",
    priceOld: "19 USD", priceNew: "19 USD", boolValue: "true", boolObserved: null,
    textValue: "48 hours", textObserved: null,
    questions: ["How much is Copperline?", "Do you offer decaf?"],
    verdicts: [], failedCheck: false, discovery: "scope-only",
  },
  {
    slug: "driftwell", name: "Driftwell Fitness", domain: "driftwell.example",
    priceOld: "59 USD", priceNew: "45 USD", boolValue: "true", boolObserved: "true",
    textValue: "7 days", textObserved: "7 days",
    questions: ["How much is Driftwell?", "Is there a trial period?"],
    verdicts: ["PARTIAL"], failedCheck: true, discovery: "partial",
  },
]

async function main(): Promise<void> {
const db = new pg.Client({ connectionString: url })
await db.connect()
try {
  const existingUser = await db.query(`SELECT id FROM users WHERE email = $1`, [DEMO_EMAIL])
  let accountId: string
  if (existingUser.rows.length > 0) {
    await db.query(`UPDATE users SET password_hash = $2 WHERE email = $1`, [DEMO_EMAIL, hashPassword(DEMO_PASSWORD)])
    accountId = (await db.query(
      `SELECT au.account_id FROM account_users au JOIN users u ON u.id = au.user_id WHERE u.email = $1 LIMIT 1`, [DEMO_EMAIL]))
      .rows[0]["account_id"] as string
  } else {
    accountId = (await db.query(`INSERT INTO accounts (name) VALUES ('Northstar Demo') RETURNING id`)).rows[0]["id"] as string
    const userId: string = (
      await db.query(`INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id`, [DEMO_EMAIL, hashPassword(DEMO_PASSWORD)])
    ).rows[0]["id"] as string
    await db.query(`INSERT INTO account_users (account_id, user_id) VALUES ($1,$2)`, [accountId, userId])
  }

  for (const spec of COMPANIES) {
    const found = await db.query(`SELECT id FROM businesses WHERE account_id = $1 AND name = $2`, [accountId, spec.name])
    if (found.rows.length > 0) {
      console.log(`skip ${spec.name} (already seeded)`)
      continue
    }
    await seedCompany(db, accountId, spec)
    console.log(`seeded ${spec.name}`)
  }
  console.log(`demo ready: login ${DEMO_EMAIL} / ${DEMO_PASSWORD}`)
} finally {
  await db.end()
}
}

const qid = async (db: pg.Client, sql: string, params: Array<unknown>): Promise<string> =>
  (await db.query(sql, params)).rows[0]["id"] as string

async function seedCompany(db: pg.Client, accountId: string, spec: CompanySpec): Promise<void> {
  const businessId = await qid(db, `INSERT INTO businesses (account_id, name) VALUES ($1,$2) RETURNING id`, [accountId, spec.name])

  const priceV1 = await qid(db,
    `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, valid_from, source_kind)
     VALUES ($1,$2,'monthly_price',$3,'CURRENCY','SUPERSEDED',1,'2026-01-01T00:00:00Z','MANUAL') RETURNING id`,
    [businessId, spec.slug, spec.priceOld])
  const priceV2 = await qid(db,
    `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, status, version, supersedes_id, valid_from, source_kind)
     VALUES ($1,$2,'monthly_price',$3,'CURRENCY','ACTIVE',2,$4,'2026-09-01T00:00:00Z','MANUAL') RETURNING id`,
    [businessId, spec.slug, spec.priceNew, priceV1])
  const boolFact = await qid(db,
    `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, source_kind)
     VALUES ($1,$2,'phone_support',$3,'BOOLEAN','2026-01-01T00:00:00Z','MANUAL') RETURNING id`,
    [businessId, spec.slug, spec.boolValue])
  const textFact = await qid(db,
    `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, source_kind)
     VALUES ($1,$2,'refund_window',$3,'TEXT','2026-01-01T00:00:00Z','MANUAL') RETURNING id`,
    [businessId, spec.slug, spec.textValue])

  // Questions + runs. Copperline stays QUEUED-only (empty states).
  const hasEvidence = spec.discovery !== "scope-only"
  const questionIds: string[] = []
  for (const prompt of spec.questions) {
    questionIds.push(await qid(db, `INSERT INTO buyer_questions (business_id, prompt, origin) VALUES ($1,$2,'BUSINESS_OWNER') RETURNING id`, [businessId, prompt]))
  }
  const runIds: string[] = []
  if (hasEvidence) {
    for (const q of questionIds) {
      runIds.push(await qid(db,
        `INSERT INTO check_runs (business_id, question_id, provider, requested_model, status, started_at, completed_at)
         VALUES ($1,$2,'mock','mock-1','SUCCEEDED', now() - interval '2 hours', now() - interval '2 hours' + interval '40 seconds') RETURNING id`,
        [businessId, q]))
    }
    if (spec.failedCheck) {
      await db.query(
        `INSERT INTO check_runs (business_id, question_id, provider, status, started_at, completed_at, failure_class, failure_detail_safe)
         VALUES ($1,$2,'mock','FAILED', now() - interval '1 hour', now() - interval '1 hour' + interval '8 seconds','PROVIDER_TIMEOUT','mock provider timed out')`,
        [businessId, questionIds[0]])
    }
  } else {
    await db.query(`INSERT INTO check_runs (business_id, question_id, provider, status) VALUES ($1,$2,'mock','QUEUED')`, [businessId, questionIds[0]])
  }

  // Observations + citations + claims + judgments.
  if (hasEvidence && runIds.length > 0) {
    const rawId = await qid(db, `INSERT INTO raw_evidence (digest, content_text) VALUES ($1,'{}') RETURNING id`, [`demo-${spec.slug}-1`])
    const obsId = await qid(db,
      `INSERT INTO observations (business_id, check_run_id, provider, observed_model, collected_at, answer_text, retrieval_mode, raw_evidence_id, raw_digest)
       VALUES ($1,$2,'mock','mock-1', now() - interval '2 hours', $3,'grounded',$4,$5) RETURNING id`,
      [businessId, runIds[0], `${spec.name} costs ${spec.priceNew} per month. See https://${spec.domain}/pricing for details.`, rawId, `demo-${spec.slug}-1`])
    await db.query(`INSERT INTO observation_citations (observation_id, uri, title, position, attributed) VALUES ($1,$2,'Pricing page',1,true)`, [obsId, `https://${spec.domain}/pricing`])
    for (const [i, verdict] of spec.verdicts.entries()) {
      const claimId = await qid(db, `INSERT INTO candidate_claims (business_id, observation_id, text) VALUES ($1,$2,$3) RETURNING id`,
        [businessId, obsId, `${spec.name} claim ${i + 1}: monthly price is ${spec.priceNew}`])
      if (verdict !== "NEEDS_REVIEW") {
        const judgmentId = await qid(db, `INSERT INTO human_judgments (business_id, claim_id, verdict, notes) VALUES ($1,$2,$3,'demo judgment') RETURNING id`,
          [businessId, claimId, verdict])
        await db.query(`INSERT INTO human_judgment_facts (judgment_id, fact_id) VALUES ($1,$2)`, [judgmentId, priceV2])
      }
    }
  }

  // Representation Graph: targets + bindings always; observations only with evidence.
  const t1 = await qid(db, `INSERT INTO source_targets (business_id, url, control) VALUES ($1,$2,'OWNED') RETURNING id`, [businessId, `https://${spec.domain}/pricing`])
  const t2 = await qid(db, `INSERT INTO source_targets (business_id, url, control) VALUES ($1,$2,'THIRD_PARTY') RETURNING id`, [businessId, `https://press.example/${spec.slug}-review`])
  const bPrice = await qid(db,
    `INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator)
     VALUES ($1,$2,$3,'JSON_LD','offers.price','MONEY') RETURNING id`, [businessId, priceV2, t1])
  const bBool = await qid(db,
    `INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator)
     VALUES ($1,$2,$3,'META_CONTENT','meta[name="support"]','BOOLEAN') RETURNING id`, [businessId, boolFact, t1])
  const bText = await qid(db,
    `INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator)
     VALUES ($1,$2,$3,'CSS_TEXT','.policy','EXACT_TEXT') RETURNING id`, [businessId, textFact, t2])

  if (hasEvidence) {
    const so1 = await qid(db,
      `INSERT INTO source_observations (business_id, source_target_id, collector, collector_version, requested_url, final_url, started_at, completed_at,
        http_status, content_type, etag, body_digest, body_bytes, collection_state)
       VALUES ($1,$2,'NATIVE_HTTP','native-http/1',$3,$3, now() - interval '3 hours', now() - interval '3 hours' + interval '2 seconds',
        200,'text/html','"demo-1"','digest-demo-1',4100,'FETCHED') RETURNING id`,
      [businessId, t1, `https://${spec.domain}/pricing`])
    await db.query(
      `INSERT INTO observed_source_values (business_id, source_observation_id, source_binding_id, fact_id, extracted_value, extraction_state, evidence_selector, evidence_observation_id, evidence_node_identity)
       VALUES ($1,$2,$3,$4,$5,'OBSERVED','offers.price',$2,'json-ld:offers.price')`,
      [businessId, so1, bPrice, priceV2, spec.priceNew])
    if (spec.boolObserved !== null) {
      await db.query(
        `INSERT INTO observed_source_values (business_id, source_observation_id, source_binding_id, fact_id, extracted_value, extraction_state, evidence_selector, evidence_observation_id, evidence_node_identity)
         VALUES ($1,$2,$3,$4,$5,'OBSERVED','meta[name="support"]',$2,'meta:meta[name="support"]')`,
        [businessId, so1, bBool, boolFact, spec.boolObserved])
    }
    const so2 = await qid(db,
      `INSERT INTO source_observations (business_id, source_target_id, collector, collector_version, requested_url, final_url, started_at, completed_at,
        http_status, content_type, body_digest, body_bytes, collection_state)
       VALUES ($1,$2,'NATIVE_HTTP','native-http/1',$3,$3, now() - interval '3 hours', now() - interval '3 hours' + interval '2 seconds',
        200,'text/html','digest-demo-2',8800,'FETCHED') RETURNING id`,
      [businessId, t2, `https://press.example/${spec.slug}-review`])
    if (spec.textObserved !== null) {
      await db.query(
        `INSERT INTO observed_source_values (business_id, source_observation_id, source_binding_id, fact_id, extracted_value, extraction_state, evidence_selector, evidence_observation_id, evidence_node_identity)
         VALUES ($1,$2,$3,$4,$5,'OBSERVED','.policy',$2,'css:.policy')`,
        [businessId, so2, bText, textFact, spec.textObserved])
    } else {
      await db.query(
        `INSERT INTO observed_source_values (business_id, source_observation_id, source_binding_id, fact_id, extracted_value, extraction_state, evidence_selector, evidence_observation_id, evidence_node_identity)
         VALUES ($1,$2,$3,$4,NULL,'NOT_FOUND','.policy',$2,NULL)`,
        [businessId, so2, bText, textFact])
    }
  }

  // Discovery per company character.
  const scopeId = await qid(db,
    `INSERT INTO discovery_scopes (business_id, root_url, canonical_origin, path_prefix, ownership_assertion)
     VALUES ($1,$2,$3,'/','OPERATOR_ASSERTED_OWNED') RETURNING id`,
    [businessId, `https://${spec.domain}/`, `https://${spec.domain}`])
  if (spec.discovery === "scope-only") return

  const snapshot = buildAuthoritySnapshot([
    { id: priceV1, lineageRootId: priceV1, version: 1, valueType: "CURRENCY", valueText: spec.priceOld, supersedesId: null },
    { id: priceV2, lineageRootId: priceV1, version: 2, valueType: "CURRENCY", valueText: spec.priceNew, supersedesId: priceV1 },
    { id: boolFact, lineageRootId: boolFact, version: 1, valueType: "BOOLEAN", valueText: spec.boolValue, supersedesId: null },
    { id: textFact, lineageRootId: textFact, version: 1, valueType: "TEXT", valueText: spec.textValue, supersedesId: null },
  ])
  const stale = spec.discovery === "historical-stale"
  const partial = spec.discovery === "partial"
  const singlePage = spec.discovery === "current-only" || partial
  const runId = await qid(db,
    `INSERT INTO discovery_runs (business_id, scope_id, authority_snapshot_digest, matcher_version, policy_version, state, started_at, completed_at, heartbeat_at,
      pages_fetched, bytes_downloaded, candidates_found, failure_class, failure_detail_safe)
     VALUES ($1,$2,$3,'discovery-matcher/1','discovery-policy/1',$4, now() - interval '1 hour', now() - interval '50 minutes', now() - interval '50 minutes', $5, 12400, $6, $7, $8) RETURNING id`,
    [businessId, scopeId, stale ? "stale-digest-demo" : snapshot.digest, partial ? "PARTIAL" : "SUCCEEDED",
      singlePage ? 1 : 2, singlePage ? 1 : 2,
      partial ? "BUDGET_EXHAUSTED" : null, partial ? "page budget reached" : null])
  const pages: Array<{ url: string; via: string; matches: Array<{ root: string; fact: string; version: number; value: string; surface: "JSON_LD" | "META" | "VISIBLE_TEXT"; locator: string; snippet: string; relation: "CURRENT_VALUE" | "HISTORICAL_VALUE" }> }> =
    singlePage
      ? [{ url: `https://${spec.domain}/pricing`, via: "SITEMAP",
          matches: [{ root: priceV1, fact: priceV2, version: 2, value: spec.priceNew, surface: "JSON_LD", locator: "json-ld:offers.price", snippet: `offers.price = ${spec.priceNew}`, relation: "CURRENT_VALUE" }] }]
      : spec.discovery === "historical-stale"
      ? [{ url: `https://${spec.domain}/docs/billing`, via: "SITEMAP",
          matches: [{ root: priceV1, fact: priceV1, version: 1, value: spec.priceOld, surface: "VISIBLE_TEXT", locator: "body.main", snippet: `was ${spec.priceOld} per month`, relation: "HISTORICAL_VALUE" }] }]
      : [{ url: `https://${spec.domain}/pricing`, via: "SITEMAP",
          matches: [{ root: priceV1, fact: priceV2, version: 2, value: spec.priceNew, surface: "JSON_LD", locator: "json-ld:offers.price", snippet: `offers.price = ${spec.priceNew}`, relation: "CURRENT_VALUE" }] },
        { url: `https://${spec.domain}/docs/billing`, via: "SITEMAP",
          matches: [{ root: priceV1, fact: priceV1, version: 1, value: spec.priceOld, surface: "VISIBLE_TEXT", locator: "body.main", snippet: `was ${spec.priceOld} per month`, relation: "HISTORICAL_VALUE" }] }];
  let order = 0
  for (const [i, page] of pages.entries()) {
    await db.query(
      `INSERT INTO discovery_frontier (run_id, business_id, canonical_url, requested_url, discovered_via, depth, state, order_key)
       VALUES ($1,$2,$3,$3,$4,0,'DONE',$5)`,
      [runId, businessId, page.url, page.via, String(order++).padStart(6, "0")])
    const obsId = await qid(db,
      `INSERT INTO discovery_observations (business_id, scope_id, run_id, resource_kind, requested_url, canonical_url, final_url, discovered_via, started_at, completed_at,
        http_status, content_type, etag, body_digest, body_bytes, collection_state)
       VALUES ($1,$2,$3,'PAGE',$4,$4,$4,$5, now() - interval '1 hour', now() - interval '55 minutes' + ($6 || ' seconds')::interval, 200,'text/html','"demo-etag"','digest-demo',4100,'FETCHED') RETURNING id`,
      [businessId, scopeId, runId, page.url, page.via, String(i * 5)])
    for (const m of page.matches) {
      await db.query(
        `INSERT INTO discovery_matches (business_id, run_id, page_observation_id, lineage_root_fact_id, matched_fact_id, matched_fact_version, matched_value, match_surface, evidence_locator, evidence_snippet, relation_at_scan, matcher_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'discovery-matcher/1')`,
        [businessId, runId, obsId, m.root, m.fact, m.version, m.value, m.surface, m.locator, m.snippet, m.relation])
    }
  }
}

void main()
