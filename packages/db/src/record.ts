// Client record persistence (migration 0022). Account = agency, Business =
// client. Writes are human acts attributed to the session user; the database
// re-checks membership, tenancy and append-only history. Reads return the
// evidence rows as stored; outcomes are derived by the API, never stored.
import { randomBytes } from "node:crypto"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import type { Session } from "./auth.js"
import { decodeRow, iso, type RowDecodeError } from "./row-codecs.js"

export const RECORD_SLOTS = [1, 2, 3] as const
export type RecordSlot = (typeof RECORD_SLOTS)[number]
export type RecordEngagement = "CLIENT" | "DOGFOOD" | "FIXTURE"
export type RecordDecision = "MATCHES" | "CONTRADICTS" | "UNKNOWN"
export type RecordRunKind = "INITIAL" | "FOLLOW_UP"
export type RecordFactValueType = "TEXT" | "NUMBER" | "CURRENCY" | "BOOLEAN" | "DATE" | "URL" | "ENUM"
export type RecordActionType = "SOURCE_UPDATED" | "SOURCE_PUBLISHED" | "STRUCTURED_DATA_UPDATED" | "THIRD_PARTY_CORRECTION_REQUESTED" | "OTHER"

/** A business rule refused the request; `reason` is a stable machine code. */
export class RecordRefused extends Data.TaggedError("RecordRefused")<{ readonly reason: string }> {}
type RecordEffect<A> = Effect.Effect<A, SqlError | RowDecodeError | RecordRefused>

const Ts = Schema.Union(Schema.instanceOf(Date), Schema.String)
const NullableTs = Schema.NullOr(Ts)
const Str = Schema.String
const NullableStr = Schema.NullOr(Schema.String)

const ProfileSchema = Schema.Struct({ business_id: Schema.UUID, name: Str, website_url: Str,
  engagement: Schema.Literal("CLIENT", "DOGFOOD", "FIXTURE"), created_at: Ts })
const ItemSchema = Schema.Struct({
  id: Schema.UUID, slot: Schema.Literal(1, 2, 3), fact_id: Schema.UUID, question_id: Schema.UUID, source_url: Str,
  supersedes_id: Schema.NullOr(Schema.UUID), superseded: Schema.Boolean, created_at: Ts,
  approved_at: NullableTs, approved_by_user_id: Schema.NullOr(Schema.UUID),
  fact_subject: Str, fact_predicate: Str, fact_value_text: Str, fact_value_type: Str, fact_version: Schema.Number,
  fact_status: Str, fact_valid_from: Ts, fact_valid_until: NullableTs, question_prompt: Str,
})
const RunSchema = Schema.Struct({ id: Schema.UUID, kind: Schema.Literal("INITIAL", "FOLLOW_UP"), baseline_run_id: Schema.NullOr(Schema.UUID),
  provider: Str, requested_model: NullableStr, retrieval_required: Schema.Boolean, created_at: Ts })
const CitationSchema = Schema.Struct({ uri: NullableStr, title: NullableStr, position: Schema.NullOr(Schema.Number) })
const JudgmentSchema = Schema.Struct({ id: Schema.UUID, decision: Schema.Literal("MATCHES", "CONTRADICTS", "UNKNOWN"), note: NullableStr,
  supersedes_id: Schema.NullOr(Schema.UUID), reviewed_by_user_id: Schema.UUID, reviewed_at: Ts })
const ObservationSchema = Schema.Struct({
  id: Schema.UUID, provider: Str, requested_model: NullableStr, observed_model: NullableStr, model_version: NullableStr,
  collected_at: Ts, answer_text: Str, retrieval_mode: Str, retrieval_tool: NullableStr, request_parameters: Schema.Unknown,
  raw_digest: Str, synthetic: Schema.Boolean, measurement_context: Schema.Unknown, provider_metadata: Schema.Unknown,
})
const CheckSchema = Schema.Struct({
  id: Schema.UUID, record_run_id: Schema.UUID, record_item_id: Schema.UUID, question_id: Schema.UUID,
  status: Schema.Literal("QUEUED", "RUNNING", "SUCCEEDED", "FAILED"), failure_class: NullableStr, failure_detail_safe: NullableStr,
  queued_at: Ts, completed_at: NullableTs,
  observation: Schema.NullOr(ObservationSchema), citations: Schema.Array(CitationSchema), judgments: Schema.Array(JudgmentSchema),
})
const ActionSchema = Schema.Struct({ id: Schema.UUID, slot: Schema.NullOr(Schema.Number), type: Str, note: NullableStr,
  links: Schema.Array(Str), performed_at: Ts, actor_id: NullableStr, created_at: Ts })
const ShareSchema = Schema.Struct({ id: Schema.UUID, public_id: Str, status: Schema.Literal("ACTIVE", "REVOKED"), created_at: Ts, revoked_at: NullableTs })

export interface RecordProfile { readonly businessId: string; readonly name: string; readonly websiteUrl: string; readonly engagement: RecordEngagement; readonly createdAt: string }
export interface RecordItem {
  readonly id: string
  readonly slot: RecordSlot
  readonly supersedesId: string | null
  /** False for the current version of the slot. */
  readonly superseded: boolean
  readonly createdAt: string
  readonly sourceUrl: string
  readonly approval: { readonly approvedAt: string; readonly approvedByUserId: string } | null
  readonly fact: { readonly id: string; readonly subject: string; readonly predicate: string; readonly valueText: string; readonly valueType: string;
    readonly version: number; readonly status: string; readonly validFrom: string; readonly validUntil: string | null }
  readonly question: { readonly id: string; readonly prompt: string }
}
export interface RecordRun { readonly id: string; readonly kind: RecordRunKind; readonly baselineRunId: string | null; readonly provider: string
  readonly requestedModel: string | null; readonly retrievalRequired: boolean; readonly createdAt: string }
export interface RecordJudgment { readonly id: string; readonly decision: RecordDecision; readonly note: string | null; readonly supersedesId: string | null
  readonly reviewedByUserId: string; readonly reviewedAt: string }
export interface RecordObservation {
  readonly id: string
  readonly provider: string
  readonly requestedModel: string | null
  readonly observedModel: string | null
  readonly modelVersion: string | null
  readonly collectedAt: string
  /** Exact persisted answer text; never summarized. */
  readonly answerText: string
  readonly retrievalMode: string
  readonly retrievalTool: string | null
  readonly requestParameters: unknown
  readonly rawDigest: string
  readonly synthetic: boolean
  readonly measurementContext: unknown
  readonly providerMetadata: unknown
  readonly citations: ReadonlyArray<{ readonly uri: string | null; readonly title: string | null; readonly position: number | null }>
}
export interface RecordCheck {
  readonly id: string
  readonly runId: string
  readonly itemId: string
  readonly questionId: string
  readonly status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED"
  readonly failureClass: string | null
  readonly failureDetailSafe: string | null
  readonly queuedAt: string
  readonly completedAt: string | null
  readonly observation: RecordObservation | null
  /** Full append-only chain, oldest first. */
  readonly judgments: ReadonlyArray<RecordJudgment>
}
export interface RecordAction { readonly id: string; readonly slot: number | null; readonly type: string; readonly note: string | null
  readonly links: ReadonlyArray<string>; readonly performedAt: string; readonly actorId: string | null; readonly createdAt: string }
export interface RecordShare { readonly id: string; readonly publicId: string; readonly status: "ACTIVE" | "REVOKED"; readonly createdAt: string; readonly revokedAt: string | null }
export interface RecordSnapshot {
  readonly profile: RecordProfile
  /** Every slot version, oldest first. */
  readonly items: ReadonlyArray<RecordItem>
  /** Oldest first. */
  readonly runs: ReadonlyArray<RecordRun>
  readonly checks: ReadonlyArray<RecordCheck>
  readonly actions: ReadonlyArray<RecordAction>
  readonly share: RecordShare | null
}

export interface SaveSlotInput {
  readonly slot: RecordSlot
  readonly subject: string
  readonly predicate: string
  readonly valueText: string
  readonly valueType: RecordFactValueType
  readonly validFrom?: string
  readonly validUntil?: string | null
  readonly sourceUrl: string
  readonly question: string
}
export interface RecordActionInput {
  readonly slot: RecordSlot | null
  readonly type: RecordActionType
  readonly note: string
  readonly links: ReadonlyArray<string>
  readonly performedAt: string
}

export class RecordRepository extends Context.Tag("RecordRepository")<RecordRepository, {
  readonly listClients: (accountId: string) => RecordEffect<ReadonlyArray<RecordProfile & { readonly hasActiveShare: boolean; readonly lastCheckedAt: string | null }>>
  readonly createClient: (session: Session, input: { name: string; websiteUrl: string; engagement: RecordEngagement }) => RecordEffect<RecordProfile>
  readonly updateClient: (businessId: string, input: { name: string; websiteUrl: string }) => RecordEffect<void>
  readonly saveSlot: (session: Session, businessId: string, input: SaveSlotInput) => RecordEffect<RecordItem>
  readonly approveItem: (session: Session, businessId: string, itemId: string) => RecordEffect<void>
  readonly startRun: (session: Session, businessId: string, input: { kind: RecordRunKind | null; provider: string; requestedModel: string | null }) => RecordEffect<RecordRun>
  readonly judge: (session: Session, businessId: string, input: { observationId: string; decision: RecordDecision; note: string | null }) => RecordEffect<RecordJudgment>
  readonly recordAction: (session: Session, businessId: string, input: RecordActionInput) => RecordEffect<RecordAction>
  readonly share: (session: Session, businessId: string) => RecordEffect<RecordShare>
  readonly revokeShare: (session: Session, businessId: string) => RecordEffect<void>
  /** null when the business has no record profile. */
  readonly snapshot: (businessId: string) => RecordEffect<RecordSnapshot | null>
  /** Business of an ACTIVE share; null for unknown and revoked ids alike. */
  readonly businessForPublicId: (publicId: string) => RecordEffect<string | null>
}>() {}

const toItem = (r: typeof ItemSchema.Type): RecordItem => ({
  id: r.id, slot: r.slot, supersedesId: r.supersedes_id, superseded: r.superseded, createdAt: iso(r.created_at), sourceUrl: r.source_url,
  approval: r.approved_at === null || r.approved_by_user_id === null ? null : { approvedAt: iso(r.approved_at), approvedByUserId: r.approved_by_user_id },
  fact: { id: r.fact_id, subject: r.fact_subject, predicate: r.fact_predicate, valueText: r.fact_value_text, valueType: r.fact_value_type,
    version: r.fact_version, status: r.fact_status, validFrom: iso(r.fact_valid_from), validUntil: r.fact_valid_until === null ? null : iso(r.fact_valid_until) },
  question: { id: r.question_id, prompt: r.question_prompt },
})
const toRun = (r: typeof RunSchema.Type): RecordRun => ({ id: r.id, kind: r.kind, baselineRunId: r.baseline_run_id, provider: r.provider,
  requestedModel: r.requested_model, retrievalRequired: r.retrieval_required, createdAt: iso(r.created_at) })
const toJudgment = (j: typeof JudgmentSchema.Type): RecordJudgment => ({ id: j.id, decision: j.decision, note: j.note, supersedesId: j.supersedes_id,
  reviewedByUserId: j.reviewed_by_user_id, reviewedAt: iso(j.reviewed_at) })
const toShare = (s: typeof ShareSchema.Type): RecordShare => ({ id: s.id, publicId: s.public_id, status: s.status, createdAt: iso(s.created_at),
  revokedAt: s.revoked_at === null ? null : iso(s.revoked_at) })
const toAction = (a: typeof ActionSchema.Type): RecordAction => ({ id: a.id, slot: a.slot, type: a.type, note: a.note, links: a.links,
  performedAt: iso(a.performed_at), actorId: a.actor_id, createdAt: iso(a.created_at) })

/** 32 random bytes, base64url: the only handle the public page accepts. */
export const newPublicRecordId = (): string => randomBytes(32).toString("base64url")

export const RecordRepositoryLive = Layer.effect(RecordRepository, Effect.map(PgClient.PgClient, sql => {
  const refuse = (reason: string) => Effect.fail(new RecordRefused({ reason }))
  const itemsQuery = (businessId: string, itemId: string | null = null) => sql`
    SELECT i.id, i.slot, i.fact_id, i.question_id, i.source_url, i.supersedes_id, i.created_at,
      EXISTS (SELECT 1 FROM record_items n WHERE n.supersedes_id = i.id) AS superseded,
      a.approved_at, a.approved_by_user_id,
      f.subject AS fact_subject, f.predicate AS fact_predicate, f.value_text AS fact_value_text, f.value_type AS fact_value_type,
      f.version AS fact_version, f.status AS fact_status, f.valid_from AS fact_valid_from, f.valid_until AS fact_valid_until,
      q.prompt AS question_prompt
    FROM record_items i
    JOIN authoritative_facts f ON f.id = i.fact_id AND f.business_id = i.business_id
    JOIN buyer_questions q ON q.id = i.question_id AND q.business_id = i.business_id
    LEFT JOIN record_item_approvals a ON a.item_id = i.id
    WHERE i.business_id = ${businessId} AND (${itemId}::uuid IS NULL OR i.id = ${itemId}::uuid)
    ORDER BY i.created_at, i.id`.pipe(Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(ItemSchema, "record_items", r).pipe(Effect.map(toItem)))))
  const heads = (businessId: string) => itemsQuery(businessId).pipe(Effect.map(items => items.filter(i => !i.superseded)))
  /** Serializes every structural write of one client record. */
  const lockClient = (businessId: string) => sql`SELECT business_id FROM record_profiles WHERE business_id = ${businessId} FOR UPDATE`.pipe(
    Effect.flatMap(rows => rows.length === 1 ? Effect.void : refuse("RecordNotFound")))

  return {
    listClients: accountId => sql`
      SELECT p.business_id, b.name, p.website_url, p.engagement, p.created_at,
        EXISTS (SELECT 1 FROM record_shares s WHERE s.business_id = p.business_id AND s.status = 'ACTIVE') AS has_active_share,
        (SELECT max(o.collected_at) FROM observations o JOIN check_runs c ON c.id = o.check_run_id WHERE c.business_id = p.business_id AND c.record_run_id IS NOT NULL) AS last_checked_at
      FROM record_profiles p JOIN businesses b ON b.id = p.business_id WHERE b.account_id = ${accountId} ORDER BY b.name, p.business_id`.pipe(
      Effect.flatMap(rows => Effect.forEach(rows, r => Effect.gen(function*() {
        const p = yield* decodeRow(ProfileSchema, "record_profiles", r)
        return { businessId: p.business_id, name: p.name, websiteUrl: p.website_url, engagement: p.engagement, createdAt: iso(p.created_at),
          hasActiveShare: Boolean(r["has_active_share"]), lastCheckedAt: r["last_checked_at"] ? iso(r["last_checked_at"] as Date) : null }
      })))),

    createClient: (session, input) => Effect.gen(function*() {
      const business = yield* sql`INSERT INTO businesses (account_id, name) VALUES (${session.accountId}, ${input.name}) RETURNING id`
      const businessId = String(business[0]!["id"])
      yield* sql`INSERT INTO record_profiles (business_id, website_url, engagement) VALUES (${businessId}, ${input.websiteUrl}, ${input.engagement})`
      const rows = yield* sql`SELECT p.business_id, b.name, p.website_url, p.engagement, p.created_at FROM record_profiles p JOIN businesses b ON b.id = p.business_id WHERE p.business_id = ${businessId}`
      const p = yield* decodeRow(ProfileSchema, "record_profiles", rows[0])
      return { businessId: p.business_id, name: p.name, websiteUrl: p.website_url, engagement: p.engagement, createdAt: iso(p.created_at) }
    }).pipe(sql.withTransaction),

    updateClient: (businessId, input) => Effect.gen(function*() {
      yield* lockClient(businessId)
      yield* sql`UPDATE businesses SET name = ${input.name} WHERE id = ${businessId}`
      yield* sql`UPDATE record_profiles SET website_url = ${input.websiteUrl}, updated_at = now() WHERE business_id = ${businessId}`
    }).pipe(sql.withTransaction),

    saveSlot: (session, businessId, input) => Effect.gen(function*() {
      yield* lockClient(businessId)
      const mode = yield* sql`SELECT writer FROM business_authority_mode WHERE business_id = ${businessId}`
      if (mode[0] && mode[0]["writer"] === "REPOSITORY_MANIFEST") return yield* refuse("FactsManagedByRepository")
      const head = (yield* heads(businessId)).find(i => i.slot === input.slot) ?? null
      const validFrom = input.validFrom ?? head?.fact.validFrom ?? new Date().toISOString()
      const validUntil = input.validUntil === undefined ? head?.fact.validUntil ?? null : input.validUntil
      if (validUntil !== null && Date.parse(validUntil) <= Date.parse(validFrom)) return yield* refuse("InvalidFactValidity")
      // Fact identity is (subject, predicate). A changed value supersedes the
      // version the slot tracks; a different identity is a new fact.
      let factId: string
      const sameIdentity = head !== null && head.fact.subject === input.subject && head.fact.predicate === input.predicate && head.fact.status === "ACTIVE"
      const sameValue = sameIdentity && head.fact.valueText === input.valueText && head.fact.valueType === input.valueType
        && head.fact.validFrom === new Date(validFrom).toISOString() && head.fact.validUntil === (validUntil === null ? null : new Date(validUntil).toISOString())
      if (sameValue) {
        factId = head!.fact.id
      } else if (sameIdentity) {
        yield* sql`UPDATE authoritative_facts SET status = 'SUPERSEDED' WHERE id = ${head!.fact.id} AND business_id = ${businessId}`
        const rows = yield* sql`INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, version, supersedes_id, valid_from, valid_until, source_kind)
          VALUES (${businessId}, ${input.subject}, ${input.predicate}, ${input.valueText}, ${input.valueType}, ${head!.fact.version + 1}, ${head!.fact.id},
            ${validFrom}::timestamptz, ${validUntil}::timestamptz, 'WEBSITE') RETURNING id`
        factId = String(rows[0]!["id"])
      } else {
        const rows = yield* sql`INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, valid_until, source_kind)
          VALUES (${businessId}, ${input.subject}, ${input.predicate}, ${input.valueText}, ${input.valueType}, ${validFrom}::timestamptz, ${validUntil}::timestamptz, 'WEBSITE') RETURNING id`
        factId = String(rows[0]!["id"])
      }
      // A question is never edited in place: changed wording is a new
      // question, so earlier checks keep the exact prompt they asked.
      let questionId: string
      if (head !== null && head.question.prompt === input.question) {
        questionId = head.question.id
      } else {
        const rows = yield* sql`INSERT INTO buyer_questions (business_id, label, prompt, origin) VALUES (${businessId}, ${`Record slot ${input.slot}`}, ${input.question}, 'OPERATOR_CONSTRUCTED') RETURNING id`
        questionId = String(rows[0]!["id"])
      }
      if (head !== null && head.fact.id === factId && head.question.id === questionId && head.sourceUrl === input.sourceUrl) return head
      const inserted = yield* sql`INSERT INTO record_items (business_id, slot, fact_id, question_id, source_url, supersedes_id, created_by_user_id)
        VALUES (${businessId}, ${input.slot}, ${factId}, ${questionId}, ${input.sourceUrl}, ${head?.id ?? null}, ${session.userId}) RETURNING id`
      const items = yield* itemsQuery(businessId, String(inserted[0]!["id"]))
      return items[0]!
    }).pipe(sql.withTransaction),

    approveItem: (session, businessId, itemId) => Effect.gen(function*() {
      yield* lockClient(businessId)
      const item = (yield* itemsQuery(businessId, itemId))[0]
      if (!item) return yield* refuse("ItemNotFound")
      if (item.superseded) return yield* refuse("ItemSuperseded")
      if (item.approval) return
      yield* sql`INSERT INTO record_item_approvals (item_id, business_id, approved_by_user_id) VALUES (${itemId}, ${businessId}, ${session.userId})`
    }).pipe(sql.withTransaction),

    startRun: (session, businessId, input) => Effect.gen(function*() {
      yield* lockClient(businessId)
      const active = yield* sql`SELECT 1 FROM check_runs WHERE business_id = ${businessId} AND record_run_id IS NOT NULL AND status IN ('QUEUED','RUNNING') LIMIT 1`
      if (active.length > 0) return yield* refuse("RunInProgress")
      const runs = (yield* sql`SELECT id, kind, baseline_run_id, provider, requested_model, retrieval_required, created_at FROM record_runs WHERE business_id = ${businessId} ORDER BY created_at, id`.pipe(
        Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(RunSchema, "record_runs", r).pipe(Effect.map(toRun))))))
      const baseline = [...runs].reverse().find(r => r.kind === "INITIAL") ?? null
      const kind: RecordRunKind = input.kind ?? (baseline === null ? "INITIAL" : "FOLLOW_UP")
      if (kind === "FOLLOW_UP" && baseline === null) return yield* refuse("NoBaseline")
      // A new baseline is allowed until the first follow-up compares against it.
      if (kind === "INITIAL" && runs.some(r => r.kind === "FOLLOW_UP")) return yield* refuse("BaselineLocked")
      const approved = (yield* heads(businessId)).filter(i => i.approval !== null && i.fact.status === "ACTIVE")
      if (approved.length === 0) return yield* refuse("NoApprovedFacts")
      const now = Date.now()
      if (approved.some(i => Date.parse(i.fact.validFrom) > now || (i.fact.validUntil !== null && Date.parse(i.fact.validUntil) <= now))) return yield* refuse("FactNotCurrentlyValid")
      const rows = yield* sql`INSERT INTO record_runs (business_id, kind, baseline_run_id, provider, requested_model, requested_by_user_id)
        VALUES (${businessId}, ${kind}, ${kind === "FOLLOW_UP" ? baseline!.id : null}, ${input.provider}, ${input.requestedModel}, ${session.userId})
        RETURNING id, kind, baseline_run_id, provider, requested_model, retrieval_required, created_at`
      const run = toRun(yield* decodeRow(RunSchema, "record_runs", rows[0]))
      for (const item of approved) {
        yield* sql`INSERT INTO check_runs (business_id, question_id, provider, requested_model, record_run_id, record_item_id)
          VALUES (${businessId}, ${item.question.id}, ${input.provider}, ${input.requestedModel}, ${run.id}, ${item.id})`
      }
      return run
    }).pipe(sql.withTransaction),

    judge: (session, businessId, input) => Effect.gen(function*() {
      const found = yield* sql`SELECT c.record_item_id FROM observations o JOIN check_runs c ON c.id = o.check_run_id
        WHERE o.id = ${input.observationId} AND o.business_id = ${businessId} AND c.record_item_id IS NOT NULL FOR UPDATE OF c`
      if (found.length !== 1) return yield* refuse("ObservationNotFound")
      // Corrections append and supersede the current head; history is kept.
      const head = yield* sql`SELECT j.id FROM record_judgments j WHERE j.observation_id = ${input.observationId}
        AND NOT EXISTS (SELECT 1 FROM record_judgments n WHERE n.supersedes_id = j.id)`
      const rows = yield* sql`INSERT INTO record_judgments (business_id, observation_id, item_id, decision, note, supersedes_id, reviewed_by_user_id)
        VALUES (${businessId}, ${input.observationId}, ${String(found[0]!["record_item_id"])}, ${input.decision}, ${input.note}, ${head[0] ? String(head[0]["id"]) : null}, ${session.userId})
        RETURNING id, decision, note, supersedes_id, reviewed_by_user_id, reviewed_at`
      return toJudgment(yield* decodeRow(JudgmentSchema, "record_judgments", rows[0]))
    }).pipe(sql.withTransaction),

    recordAction: (session, businessId, input) => Effect.gen(function*() {
      yield* lockClient(businessId)
      const profile = yield* sql`SELECT website_url FROM record_profiles WHERE business_id = ${businessId}`
      const target = input.links[0] ?? String(profile[0]!["website_url"])
      const intervention = yield* sql`INSERT INTO interventions (business_id, type, target, performed_at, actor, actor_id, notes)
        VALUES (${businessId}, ${input.type}, ${target}, ${input.performedAt}::timestamptz, 'HUMAN', ${session.userId}, ${input.note}) RETURNING id`
      const id = String(intervention[0]!["id"])
      yield* sql`INSERT INTO record_actions (intervention_id, business_id, slot, links) VALUES (${id}, ${businessId}, ${input.slot}, ${JSON.stringify(input.links)}::jsonb)`
      const rows = yield* sql`SELECT i.id, a.slot, i.type, i.notes AS note, a.links, i.performed_at, i.actor_id, a.created_at
        FROM record_actions a JOIN interventions i ON i.id = a.intervention_id WHERE a.intervention_id = ${id}`
      return toAction(yield* decodeRow(ActionSchema, "record_actions", rows[0]))
    }).pipe(sql.withTransaction),

    share: (session, businessId) => Effect.gen(function*() {
      yield* lockClient(businessId)
      const existing = yield* sql`SELECT id, public_id, status, created_at, revoked_at FROM record_shares WHERE business_id = ${businessId} AND status = 'ACTIVE'`
      if (existing[0]) return toShare(yield* decodeRow(ShareSchema, "record_shares", existing[0]))
      const rows = yield* sql`INSERT INTO record_shares (business_id, public_id, created_by_user_id) VALUES (${businessId}, ${newPublicRecordId()}, ${session.userId})
        RETURNING id, public_id, status, created_at, revoked_at`
      return toShare(yield* decodeRow(ShareSchema, "record_shares", rows[0]))
    }).pipe(sql.withTransaction),

    revokeShare: (session, businessId) => Effect.gen(function*() {
      yield* lockClient(businessId)
      yield* sql`UPDATE record_shares SET status = 'REVOKED', revoked_by_user_id = ${session.userId}, revoked_at = now() WHERE business_id = ${businessId} AND status = 'ACTIVE'`
    }).pipe(sql.withTransaction),

    snapshot: businessId => Effect.gen(function*() {
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
      const profileRows = yield* sql`SELECT p.business_id, b.name, p.website_url, p.engagement, p.created_at FROM record_profiles p JOIN businesses b ON b.id = p.business_id WHERE p.business_id = ${businessId}`
      if (!profileRows[0]) return null
      const p = yield* decodeRow(ProfileSchema, "record_profiles", profileRows[0])
      const items = yield* itemsQuery(businessId)
      const runs = yield* sql`SELECT id, kind, baseline_run_id, provider, requested_model, retrieval_required, created_at FROM record_runs WHERE business_id = ${businessId} ORDER BY created_at, id`.pipe(
        Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(RunSchema, "record_runs", r).pipe(Effect.map(toRun)))))
      const checks = yield* sql`
        SELECT c.id, c.record_run_id, c.record_item_id, c.question_id, c.status, c.failure_class, c.failure_detail_safe, c.queued_at, c.completed_at,
          CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', o.id, 'provider', o.provider, 'requested_model', o.requested_model, 'observed_model', o.observed_model, 'model_version', o.model_version,
            'collected_at', o.collected_at, 'answer_text', o.answer_text, 'retrieval_mode', o.retrieval_mode, 'retrieval_tool', o.retrieval_tool,
            'request_parameters', o.request_parameters, 'raw_digest', o.raw_digest, 'synthetic', o.synthetic, 'measurement_context', o.measurement_context,
            'provider_metadata', re.provider_metadata) END AS observation,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('uri', ci.uri, 'title', ci.title, 'position', ci.position) ORDER BY ci.position NULLS LAST, ci.id)
            FROM observation_citations ci WHERE ci.observation_id = o.id), '[]'::jsonb) AS citations,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id', j.id, 'decision', j.decision, 'note', j.note, 'supersedes_id', j.supersedes_id,
            'reviewed_by_user_id', j.reviewed_by_user_id, 'reviewed_at', j.reviewed_at) ORDER BY j.reviewed_at, j.id)
            FROM record_judgments j WHERE j.observation_id = o.id), '[]'::jsonb) AS judgments
        FROM check_runs c LEFT JOIN observations o ON o.check_run_id = c.id AND o.business_id = c.business_id
        LEFT JOIN raw_evidence re ON re.id = o.raw_evidence_id
        WHERE c.business_id = ${businessId} AND c.record_run_id IS NOT NULL ORDER BY c.queued_at, c.id`.pipe(
        Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(CheckSchema, "record_checks", r).pipe(Effect.map((c): RecordCheck => ({
          id: c.id, runId: c.record_run_id, itemId: c.record_item_id, questionId: c.question_id, status: c.status,
          failureClass: c.failure_class, failureDetailSafe: c.failure_detail_safe, queuedAt: iso(c.queued_at),
          completedAt: c.completed_at === null ? null : iso(c.completed_at),
          observation: c.observation === null ? null : {
            id: c.observation.id, provider: c.observation.provider, requestedModel: c.observation.requested_model, observedModel: c.observation.observed_model,
            modelVersion: c.observation.model_version, collectedAt: iso(c.observation.collected_at), answerText: c.observation.answer_text,
            retrievalMode: c.observation.retrieval_mode, retrievalTool: c.observation.retrieval_tool, requestParameters: c.observation.request_parameters,
            rawDigest: c.observation.raw_digest, synthetic: c.observation.synthetic, measurementContext: c.observation.measurement_context,
            providerMetadata: c.observation.provider_metadata, citations: c.citations,
          },
          judgments: c.judgments.map(toJudgment),
        }))))))
      const actions = yield* sql`SELECT i.id, a.slot, i.type, i.notes AS note, a.links, i.performed_at, i.actor_id, a.created_at
        FROM record_actions a JOIN interventions i ON i.id = a.intervention_id AND i.business_id = a.business_id
        WHERE a.business_id = ${businessId} ORDER BY i.performed_at, i.id`.pipe(
        Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(ActionSchema, "record_actions", r).pipe(Effect.map(toAction)))))
      const shares = yield* sql`SELECT id, public_id, status, created_at, revoked_at FROM record_shares WHERE business_id = ${businessId} AND status = 'ACTIVE'`
      const share = shares[0] ? toShare(yield* decodeRow(ShareSchema, "record_shares", shares[0])) : null
      return { profile: { businessId: p.business_id, name: p.name, websiteUrl: p.website_url, engagement: p.engagement, createdAt: iso(p.created_at) },
        items, runs, checks, actions, share }
    }).pipe(sql.withTransaction),

    businessForPublicId: publicId => sql`SELECT business_id FROM record_shares WHERE public_id = ${publicId} AND status = 'ACTIVE'`.pipe(
      Effect.map(rows => rows[0] ? String(rows[0]["business_id"]) : null)),
  }
}))
