import { createHash } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlError } from "@effect/sql/SqlError"
import { ASSAY_RETRIEVAL_LIMITATION } from "@openrecord/contracts"
import { normalizeUrl, ASSAY_EXTRACTOR_VERSION, confirmThreshold, extractAssayJudgment, findMoneyVariant, moneyVariants, retrievalClassification, type AssayFactType, type AssayNormalized, type ProposedAssayFact, type SafeFetchEvidence } from "@openrecord/representation"
import type { ClaimScope, DbEffect } from "./repositories.js"
import { decodeRow, NullableTextField, NullableUuidField, NullableTimestampField, TextField, UuidField } from "./row-codecs.js"
import type { Session } from "./auth.js"

const SourceSchema = Schema.Struct({ id: UuidField, business_id: UuidField, url: TextField, subject: TextField,
  plan_terms: Schema.Array(Schema.String), capability_terms: Schema.Array(Schema.String), status: TextField, claim_token: NullableUuidField,
  fetched_text: NullableTextField, raw_evidence_id: NullableUuidField, failure_class: NullableTextField, final_url: NullableTextField, fetched_at: NullableTimestampField, business_name: TextField })
export type AssaySourceRow = typeof SourceSchema.Type
const FactSchema = Schema.Struct({ id: UuidField, business_id: UuidField, source_url: TextField, source_id: NullableUuidField, fact_type: Schema.Literal("PRICE", "PLAN_AVAILABILITY", "BOOLEAN_CAPABILITY"),
  subject: TextField, normalized: Schema.Unknown, status: TextField, supporting_span: NullableTextField, extractor_version: NullableTextField, valid_from: NullableTimestampField, valid_until: NullableTimestampField,
  final_url: NullableTextField, fact_retracted: Schema.Boolean, source_links: Schema.Array(Schema.Unknown) })
export type AssayFactRow = typeof FactSchema.Type
const GroupSchema = Schema.Struct({ id: UuidField, business_id: UuidField, question_id: UuidField, provider: TextField, requested_model: NullableTextField,
  retrieval_mode: Schema.Literal("NONE", "WEB_SEARCH", "PROVIDER_GROUNDING", "MANUAL_CAPTURE"), n: Schema.Number, status: TextField,
  missing_samples: Schema.Array(Schema.Struct({ sampleNumber: Schema.Number, failureClass: Schema.String })) })
export type AssayGroupRow = typeof GroupSchema.Type
export interface AssayFindingEvidence {
  readonly id: string
  readonly verdict: string
  readonly sample_count: number
  readonly requested_n: number
  readonly contradict_count: number
  readonly unclear_count: number
  readonly retrieval_class: string
  readonly verification_eligible: boolean
  readonly source_diagnosis: unknown
  readonly retrieval_limitation: string | null
  readonly fact: AssayFactRow
  readonly question: string
  readonly group_status: string
  readonly missing_samples: AssayGroupRow["missing_samples"]
  readonly samples: readonly Record<string, unknown>[]
}
export interface RegisterAssaySource { businessId: string; url: string; subject: string; planTerms: readonly string[]; capabilityTerms: readonly string[]; requestedBy: string }
export interface EnqueueAssayGroup { businessId: string; questionId: string; provider: string; requestedModel: string | null; retrievalMode: AssayGroupRow["retrieval_mode"]; n?: number }

// Worker service deliberately has no review methods. The API supplies the
// authenticated session to the separate review service below.
export class AssayRepository extends Context.Tag("AssayRepository")<AssayRepository, {
  readonly registerSource: (input: RegisterAssaySource) => DbEffect<AssaySourceRow>
  readonly sources: (businessId: string) => DbEffect<readonly AssaySourceRow[]>
  /** Global oldest-first claim; `scope` restricts it to one business. */
  readonly claimSource: (scope?: ClaimScope) => DbEffect<AssaySourceRow | null>
  readonly completeSource: (source: AssaySourceRow, evidence: SafeFetchEvidence, text: string, facts: readonly ProposedAssayFact[]) => DbEffect<void>
  readonly enqueueGroup: (input: EnqueueAssayGroup) => DbEffect<AssayGroupRow>
  readonly groups: (businessId: string) => DbEffect<readonly AssayGroupRow[]>
  readonly requestForRun: (runId: string) => DbEffect<{ retrievalMode: AssayGroupRow["retrieval_mode"]; sampleNumber: number } | null>
  readonly facts: (businessId: string) => DbEffect<readonly AssayFactRow[]>
  readonly findings: (businessId: string) => DbEffect<readonly AssayFindingEvidence[]>
  readonly derive: (businessId?: string) => DbEffect<number>
}>() {}

export const AssayRepositoryLive = Layer.effect(AssayRepository, Effect.map(PgClient.PgClient, sql => {
  const recompute = (businessId: string | null = null) => sql`
    UPDATE assay_sample_groups g SET status = s.status, missing_samples = s.missing
    FROM (SELECT g.id,
      CASE WHEN count(r.id) <> g.n OR count(*) FILTER (WHERE r.status NOT IN ('SUCCEEDED','FAILED'))>0 THEN 'QUEUED'
           WHEN count(*) FILTER (WHERE r.status='SUCCEEDED')=g.n THEN 'SUCCEEDED'
           WHEN count(*) FILTER (WHERE r.status='SUCCEEDED')=0 THEN 'FAILED' ELSE 'PARTIALLY_SUCCEEDED' END AS status,
      COALESCE(jsonb_agg(jsonb_build_object('sampleNumber',r.sample_number,'failureClass',COALESCE(r.failure_class,'UNKNOWN')) ORDER BY r.sample_number)
        FILTER (WHERE r.status='FAILED'),'[]'::jsonb) AS missing
      FROM (SELECT * FROM assay_sample_groups WHERE status='QUEUED' AND (${businessId}::uuid IS NULL OR business_id=${businessId}::uuid)
        ORDER BY created_at,id LIMIT 200) g LEFT JOIN check_runs r ON r.assay_sample_group_id=g.id GROUP BY g.id,g.n) s
    WHERE g.id=s.id AND (g.status IS DISTINCT FROM s.status OR g.missing_samples IS DISTINCT FROM s.missing)`
  return {
    registerSource: input => Effect.gen(function*() {
      const url = normalizeUrl(input.url)
      if (!url) return yield* Effect.fail(new SqlError({ message: "invalid source URL" }))
      yield* sql`INSERT INTO assay_sources (business_id,url,subject,plan_terms,capability_terms,requested_by)
        VALUES (${input.businessId},${url},${input.subject},${JSON.stringify(input.planTerms)}::jsonb,${JSON.stringify(input.capabilityTerms)}::jsonb,${input.requestedBy}) ON CONFLICT (business_id,url) DO NOTHING`
      const rows = yield* sql`SELECT s.*,b.name AS business_name FROM assay_sources s JOIN businesses b ON b.id=s.business_id WHERE s.business_id=${input.businessId} AND s.url=${url}`
      return yield* decodeRow(SourceSchema, "assay_sources", rows[0])
    }).pipe(sql.withTransaction),
    sources: businessId => sql`SELECT s.*,b.name AS business_name FROM assay_sources s JOIN businesses b ON b.id=s.business_id WHERE s.business_id=${businessId} ORDER BY s.created_at,s.id`.pipe(
      Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(SourceSchema, "assay_sources", r)))),
    claimSource: scope => sql`WITH candidate AS (
      SELECT id FROM assay_sources WHERE (status='QUEUED' OR (status='FETCHING' AND claimed_at < now()-interval '5 minutes'))
        AND (${scope?.businessId ?? null}::uuid IS NULL OR business_id=${scope?.businessId ?? null}::uuid)
      ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE assay_sources s SET status='FETCHING',claimed_at=now(),claim_token=gen_random_uuid() FROM candidate c WHERE s.id=c.id RETURNING s.*,(SELECT name FROM businesses WHERE id=s.business_id) AS business_name`.pipe(
      Effect.flatMap(rows => rows[0] ? decodeRow(SourceSchema, "assay_sources", rows[0]) : Effect.succeed(null))),
    completeSource: (source, evidence, text, facts) => Effect.gen(function*() {
      const locked = yield* sql`SELECT status,claim_token FROM assay_sources WHERE id=${source.id} AND business_id=${source.business_id} FOR UPDATE`
      if (locked[0]?.status !== "FETCHING" || locked[0]?.claim_token !== source.claim_token) return
      const failure = evidence.failure ?? (evidence.status !== null && evidence.status >= 200 && evidence.status < 300 && evidence.body !== null ? null : "HTTP_FAILURE")
      if (failure) {
        yield* sql`UPDATE assay_sources SET status='FAILED',failure_class=${failure},fetched_at=now() WHERE id=${source.id}`
        return
      }
      if (!evidence.body || !evidence.bodyDigest) return yield* Effect.fail(new SqlError({ message: "source evidence unavailable" }))
      if (createHash("sha256").update(evidence.body).digest("hex") !== evidence.bodyDigest) return yield* Effect.fail(new SqlError({ message: "source evidence digest mismatch" }))
      const bytes = Buffer.from(evidence.body).toString("hex")
      yield* sql`INSERT INTO raw_evidence (digest,content_text,raw_bytes_hex,content_type,response_max_bytes,received_at)
        VALUES (${evidence.bodyDigest},${JSON.stringify(new TextDecoder().decode(evidence.body))},${bytes},${evidence.contentType},1000000,${evidence.completedAt}::timestamptz) ON CONFLICT (digest) DO NOTHING`
      const raw = yield* sql`SELECT id,raw_bytes_hex FROM raw_evidence WHERE digest=${evidence.bodyDigest}`
      if (raw[0]?.raw_bytes_hex !== bytes) return yield* Effect.fail(new SqlError({ message: "source evidence digest collision" }))
      yield* sql`UPDATE assay_sources SET status='FETCHED',raw_evidence_id=${String(raw[0]!.id)},fetched_text=${text},final_url=${evidence.finalUrl},
        extractor_version=${ASSAY_EXTRACTOR_VERSION},fetched_at=${evidence.completedAt}::timestamptz,failure_class=NULL WHERE id=${source.id}`
      for (const fact of facts) {
        yield* sql`INSERT INTO assay_proposed_facts (business_id,source_id,source_url,fact_type,subject,normalized,supporting_span,extractor_version)
          VALUES (${source.business_id},${source.id},${source.url},${fact.factType},${fact.subject},${JSON.stringify(fact.normalized)}::jsonb,${fact.supportingSpan},${ASSAY_EXTRACTOR_VERSION}) ON CONFLICT DO NOTHING`
      }
    }).pipe(sql.withTransaction),
    enqueueGroup: input => Effect.gen(function*() {
      if (input.provider === "mock" && process.env["NODE_ENV"] !== "test" && process.env["ASSAY_ALLOW_SYNTHETIC"] !== "1") return yield* Effect.fail(new SqlError({ message: "synthetic assays disabled" }))
      const n = input.n ?? 5
      if (!Number.isInteger(n) || n < 1 || n > 20) return yield* Effect.fail(new SqlError({ message: "assay sample count must be 1..20" }))
      const rows = yield* sql`INSERT INTO assay_sample_groups (business_id,question_id,provider,requested_model,retrieval_mode,n)
        VALUES (${input.businessId},${input.questionId},${input.provider},${input.requestedModel},${input.retrievalMode},${n}) RETURNING *`
      const group = yield* decodeRow(GroupSchema, "assay_sample_groups", rows[0])
      yield* sql`INSERT INTO check_runs (business_id,question_id,provider,requested_model,assay_sample_group_id,sample_number)
        SELECT ${input.businessId}::uuid,${input.questionId}::uuid,${input.provider},${input.requestedModel},${group.id}::uuid,generate_series(1,${n})`
      return group
    }).pipe(sql.withTransaction),
    groups: businessId => Effect.gen(function*() {
      yield* recompute(businessId)
      return yield* sql`SELECT * FROM assay_sample_groups WHERE business_id=${businessId} ORDER BY created_at DESC`.pipe(
        Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(GroupSchema, "assay_sample_groups", r))))
    }),
    requestForRun: runId => sql`SELECT g.retrieval_mode,r.sample_number FROM check_runs r JOIN assay_sample_groups g ON g.id=r.assay_sample_group_id WHERE r.id=${runId}`.pipe(
      Effect.flatMap(rows => rows[0] ? decodeRow(Schema.Struct({ retrieval_mode: GroupSchema.fields.retrieval_mode, sample_number: Schema.Number }), "assay_sample_request", rows[0]).pipe(
        Effect.map(r => ({ retrievalMode: r.retrieval_mode, sampleNumber: r.sample_number }))) : Effect.succeed(null))),
    facts: businessId => sql`SELECT p.*,s.final_url,EXISTS (SELECT 1 FROM assay_fact_retractions r WHERE r.fact_id=p.id) AS fact_retracted,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('sourceId',s2.id,'sourceUrl',s2.url,'finalUrl',s2.final_url,'snapshotAt',p2.valid_from,'supportingSpan',p2.supporting_span)),'[]')
       FROM assay_proposed_facts p2 JOIN assay_sources s2 ON s2.id=p2.source_id WHERE p2.business_id=p.business_id AND p2.fact_type=p.fact_type AND lower(trim(p2.subject))=lower(trim(p.subject)) AND p2.normalized=p.normalized) AS source_links
      FROM assay_proposed_facts p JOIN assay_sources s ON s.id=p.source_id WHERE p.business_id=${businessId} AND p.status='PROPOSED'
      AND NOT EXISTS (SELECT 1 FROM assay_proposed_facts c WHERE c.business_id=p.business_id AND c.fact_type=p.fact_type AND lower(trim(c.subject))=lower(trim(p.subject)) AND c.normalized=p.normalized
        AND (c.status='CONFIRMED' AND NOT EXISTS (SELECT 1 FROM assay_fact_retractions WHERE fact_id=c.id) OR c.status='PROPOSED' AND ROW(c.created_at,c.id)<ROW(p.created_at,p.id)))
      ORDER BY p.created_at,p.id`.pipe(Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(FactSchema, "assay_proposed_facts", r)))),
    findings: businessId => Effect.gen(function*() {
      yield* recompute(businessId)
      const rows = yield* sql`SELECT f.*,q.prompt AS question,g.status AS group_status,g.missing_samples,to_jsonb(p) || jsonb_build_object('final_url',s.final_url,'fact_retracted',false,'source_links',
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('sourceId',s2.id,'sourceUrl',s2.url,'finalUrl',s2.final_url,'snapshotAt',p2.valid_from,'supportingSpan',p2.supporting_span)),'[]')
         FROM assay_proposed_facts p2 JOIN assay_sources s2 ON s2.id=p2.source_id WHERE p2.business_id=p.business_id AND p2.fact_type=p.fact_type AND lower(trim(p2.subject))=lower(trim(p.subject)) AND p2.normalized=p.normalized)) AS fact,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('sampleNumber',r.sample_number,'status',r.status,'failureClass',r.failure_class,
          'answer',o.answer_text,'observationId',o.id,'provider',o.provider,'observedModel',o.observed_model,'synthetic',o.synthetic,'rawDigest',o.raw_digest,'retrievalMode',o.retrieval_mode,'modelVersion',o.model_version,'retrievalTool',o.retrieval_tool,
          'requestParameters',o.request_parameters,'collectedAt',o.collected_at,'comparison',j.comparison,'supportingSpan',j.supporting_span,
          'citations',(SELECT COALESCE(jsonb_agg(to_jsonb(c)),'[]') FROM observation_citations c WHERE c.observation_id=o.id)) ORDER BY r.sample_number),'[]')
          FROM check_runs r LEFT JOIN observations o ON o.check_run_id=r.id LEFT JOIN assay_sample_judgments j ON j.observation_id=o.id AND j.proposed_fact_id=p.id
          WHERE r.assay_sample_group_id=g.id) AS samples
        FROM assay_findings f JOIN assay_sample_groups g ON g.id=f.sample_group_id JOIN buyer_questions q ON q.id=g.question_id
        JOIN assay_proposed_facts p ON p.id=f.proposed_fact_id JOIN assay_sources s ON s.id=p.source_id LEFT JOIN assay_finding_reviews rv ON rv.finding_id=f.id
        WHERE f.business_id=${businessId} AND rv.finding_id IS NULL AND p.status='CONFIRMED' AND NOT EXISTS (SELECT 1 FROM assay_fact_retractions WHERE fact_id=p.id) ORDER BY f.created_at,f.id`
      return yield* Effect.forEach(rows, r => Effect.gen(function*() {
        const fact = yield* decodeRow(FactSchema, "assay_proposed_facts", r.fact)
        return { ...r, fact, retrieval_limitation: r.retrieval_class === "RETRIEVAL_ENABLED" ? null : ASSAY_RETRIEVAL_LIMITATION } as unknown as AssayFindingEvidence
      }))
    }),
    derive: scopeId => Effect.gen(function*() {
      // Global (bounded) for the worker sweep; scoped when a business is given.
      const businessId = scopeId ?? null
      yield* recompute(businessId)
      // Revisit terminal groups on every sweep: a fact confirmed after the
      // samples finished still gets its judgments. Unique keys serialize retries.
      const pairs = yield* sql`SELECT g.id AS group_id,g.business_id,g.n,g.status,o.id AS observation_id,o.answer_text,o.retrieval_mode,b.name AS business_name,s.subject AS source_subject,s.plan_terms,
        to_jsonb(f) || jsonb_build_object('final_url',s.final_url,'fact_retracted',false,'source_links','[]'::jsonb) AS fact FROM assay_sample_groups g JOIN check_runs r ON r.assay_sample_group_id=g.id AND r.status='SUCCEEDED'
        JOIN observations o ON o.check_run_id=r.id JOIN assay_proposed_facts f ON f.business_id=g.business_id AND f.status='CONFIRMED'
        JOIN assay_sources s ON s.id=f.source_id JOIN businesses b ON b.id=g.business_id
        LEFT JOIN assay_sample_judgments j ON j.observation_id=o.id AND j.proposed_fact_id=f.id
        WHERE g.status IN ('SUCCEEDED','PARTIALLY_SUCCEEDED') AND j.id IS NULL AND (${businessId}::uuid IS NULL OR g.business_id=${businessId}::uuid) AND o.collected_at>=f.valid_from AND length(o.answer_text)>0
        AND NOT EXISTS (SELECT 1 FROM assay_fact_retractions WHERE fact_id=f.id)
        AND NOT EXISTS (SELECT 1 FROM assay_proposed_facts c WHERE c.business_id=f.business_id AND c.fact_type=f.fact_type AND lower(trim(c.subject))=lower(trim(f.subject)) AND c.normalized=f.normalized AND c.status='CONFIRMED' AND NOT EXISTS (SELECT 1 FROM assay_fact_retractions WHERE fact_id=c.id) AND ROW(c.reviewed_at,c.id)<ROW(f.reviewed_at,f.id))
        ORDER BY g.created_at,g.id,r.sample_number LIMIT 200`
      for (const pair of pairs) {
        const fact = yield* decodeRow(FactSchema, "assay_proposed_facts", pair.fact)
        const judgment = extractAssayJudgment({ factType: fact.fact_type as AssayFactType, subject: fact.subject, normalized: fact.normalized as AssayNormalized, businessAliases: [String(pair.business_name), String(pair.source_subject)], planTerms: pair.plan_terms as string[] }, String(pair.answer_text))
        yield* sql`INSERT INTO assay_sample_judgments (business_id,observation_id,proposed_fact_id,comparison,supporting_span,extractor_kind,extractor_version,structured_output)
          VALUES (${fact.business_id},${String(pair.observation_id)},${fact.id},${judgment.comparison},${judgment.supportingSpan},'DETERMINISTIC',${ASSAY_EXTRACTOR_VERSION},${JSON.stringify(judgment.structuredOutput)}::jsonb) ON CONFLICT DO NOTHING`
      }
      const candidates = yield* sql`SELECT g.id AS group_id,g.business_id,g.n,to_jsonb(f) || jsonb_build_object('final_url',s.final_url,'fact_retracted',false,'source_links','[]'::jsonb) AS fact,
        bool_or(o.synthetic) AS synthetic, array_agg(o.retrieval_mode) AS retrieval_modes,
        count(*)::int AS sample_count,count(*) FILTER (WHERE j.comparison='CONTRADICTS')::int AS contradict_count,
        count(*) FILTER (WHERE j.comparison='UNCLEAR')::int AS unclear_count,
        jsonb_agg(jsonb_build_object('observationId',o.id,'supportingSpan',j.supporting_span,'retrievalMode',o.retrieval_mode,
          'structuredOutput',j.structured_output,'citations',(SELECT COALESCE(jsonb_agg(to_jsonb(c)),'[]') FROM observation_citations c WHERE c.observation_id=o.id)))
          FILTER (WHERE j.comparison='CONTRADICTS') AS contradictions
        FROM assay_sample_groups g JOIN check_runs r ON r.assay_sample_group_id=g.id AND r.status='SUCCEEDED'
        JOIN observations o ON o.check_run_id=r.id JOIN assay_proposed_facts f ON f.business_id=g.business_id AND f.status='CONFIRMED'
        JOIN assay_sources s ON s.id=f.source_id
        JOIN assay_sample_judgments j ON j.observation_id=o.id AND j.proposed_fact_id=f.id
        LEFT JOIN assay_findings existing ON existing.sample_group_id=g.id AND existing.proposed_fact_id=f.id
        WHERE g.status IN ('SUCCEEDED','PARTIALLY_SUCCEEDED') AND existing.id IS NULL AND (${businessId}::uuid IS NULL OR g.business_id=${businessId}::uuid) AND o.collected_at>=f.valid_from
        AND NOT EXISTS (SELECT 1 FROM assay_fact_retractions WHERE fact_id=f.id)
        AND NOT EXISTS (SELECT 1 FROM assay_proposed_facts c WHERE c.business_id=f.business_id AND c.fact_type=f.fact_type AND lower(trim(c.subject))=lower(trim(f.subject)) AND c.normalized=f.normalized AND c.status='CONFIRMED' AND NOT EXISTS (SELECT 1 FROM assay_fact_retractions WHERE fact_id=c.id) AND ROW(c.reviewed_at,c.id)<ROW(f.reviewed_at,f.id))
        GROUP BY g.id,f.id,s.id HAVING count(*)=(SELECT count(*) FROM check_runs rr JOIN observations oo ON oo.check_run_id=rr.id WHERE rr.assay_sample_group_id=g.id AND rr.status='SUCCEEDED' AND oo.collected_at>=f.valid_from)
          AND count(*) FILTER (WHERE j.comparison='CONTRADICTS')>0 LIMIT 100`
      let inserted = 0
      for (const c of candidates) {
        const fact = yield* decodeRow(FactSchema, "assay_proposed_facts", c.fact)
        const contradictions = c.contradictions as Array<{ observationId: string; supportingSpan: string; retrievalMode: string; structuredOutput: { parsedMoney: { amountMinor: number; currency: string } | null }; citations: unknown[] }>
        const classification = retrievalClassification(c.retrieval_modes as string[], Boolean(c.synthetic))
        const sources = yield* sql`SELECT id,url,fetched_text,raw_evidence_id FROM assay_sources WHERE business_id=${fact.business_id} AND status='FETCHED'`
        const diagnosis = { citations: contradictions.map(j => ({ observationId: j.observationId, citations: j.citations })), likelySources: sources.flatMap(s => {
          const text = String(s.fetched_text)
          const variants = contradictions.flatMap(j => j.structuredOutput.parsedMoney ? moneyVariants(j.structuredOutput.parsedMoney) : fact.fact_type === "PRICE" ? [] : [j.supportingSpan])
          const matched = [...new Set(variants)].flatMap(variant => {
            const index = findMoneyVariant(text, variant)
            return index >= 0 ? [{ variant, span: text.slice(Math.max(0, index - 60), index + variant.length + 60) }] : []
          })
          return matched.length ? [{ label: "LIKELY_SOURCE", sourceId: s.id, url: s.url, rawEvidenceId: s.raw_evidence_id,
            supportingVariants: matched.map(m => m.variant), supportingSpans: matched.map(m => m.span) }] : []
        }) }
        const result = yield* sql`INSERT INTO assay_findings (business_id,sample_group_id,proposed_fact_id,sample_count,requested_n,contradict_count,unclear_count,verdict,supporting_spans,retrieval_class,verification_eligible,source_diagnosis)
          VALUES (${fact.business_id},${String(c.group_id)},${fact.id},${Number(c.sample_count)},${Number(c.n)},${Number(c.contradict_count)},${Number(c.unclear_count)},${confirmThreshold(Number(c.contradict_count),Number(c.sample_count))},
            ${JSON.stringify(contradictions)}::jsonb,${classification.retrievalClass},${classification.verificationEligible},${JSON.stringify(diagnosis)}::jsonb) ON CONFLICT DO NOTHING RETURNING id`
        inserted += result.length
      }
      return inserted
    }),
  }
}))

export type AssayFactDecision = "CONFIRMED" | "INCORRECT_EXTRACTION" | "AMBIGUOUS"
export type AssayFindingDecision = "REVIEWED_CORRECT" | "REVIEWED_FALSE_POSITIVE" | "REVIEWED_NOT_MEANINGFUL"
export class AssayReviewRepository extends Context.Tag("AssayReviewRepository")<AssayReviewRepository, {
  readonly reviewFact: (session: Session, businessId: string, factId: string, decision: AssayFactDecision, reason: string) => DbEffect<boolean>
  readonly retractFact: (session: Session, businessId: string, factId: string, reason: string) => DbEffect<boolean>
  readonly reviewFinding: (session: Session, businessId: string, findingId: string, decision: AssayFindingDecision, reason: string) => DbEffect<boolean>
}>() {}
export const AssayReviewRepositoryLive = Layer.effect(AssayReviewRepository, Effect.map(PgClient.PgClient, sql => ({
  reviewFact: (session, businessId, factId, decision, reason) => sql`UPDATE assay_proposed_facts f SET status=${decision},reviewed_by=${session.userId},reviewed_at=now(),review_reason=${reason.trim()}
    FROM businesses b JOIN account_users au ON au.account_id=b.account_id AND au.user_id::text=${session.userId}
    WHERE f.id=${factId} AND f.business_id=${businessId} AND f.status='PROPOSED' AND b.id=f.business_id AND b.account_id=${session.accountId} RETURNING f.id`.pipe(Effect.map(r => r.length === 1)),
  retractFact: (session, businessId, factId, reason) => sql`INSERT INTO assay_fact_retractions (business_id,fact_id,retracted_by,reason)
    SELECT f.business_id,f.id,${session.userId},${reason.trim()} FROM assay_proposed_facts f
    JOIN businesses b ON b.id=f.business_id JOIN account_users au ON au.account_id=b.account_id AND au.user_id::text=${session.userId}
    WHERE f.id=${factId} AND f.business_id=${businessId} AND f.status='CONFIRMED' AND b.account_id=${session.accountId} ON CONFLICT DO NOTHING RETURNING fact_id`.pipe(Effect.map(r => r.length === 1)),
  reviewFinding: (session, businessId, findingId, decision, reason) => sql`INSERT INTO assay_finding_reviews (business_id,finding_id,reviewed_by,decision,review_reason)
    SELECT f.business_id,f.id,${session.userId},${decision},${reason.trim()} FROM assay_findings f
    JOIN businesses b ON b.id=f.business_id JOIN account_users au ON au.account_id=b.account_id AND au.user_id::text=${session.userId}
    WHERE f.id=${findingId} AND f.business_id=${businessId} AND b.account_id=${session.accountId} ON CONFLICT DO NOTHING RETURNING finding_id`.pipe(Effect.map(r => r.length === 1)),
})))
