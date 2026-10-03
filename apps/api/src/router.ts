// Effect API server: HttpRouter + HttpServer over Node.
// One typed contract (packages/contracts) shared with apps/web.
// Typed failures map deterministically to HTTP statuses (see domain/errors).
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import pg from "pg"
import {
  CreateBusinessRequest,
  CreateClaimRequest,
  CreateFactRequest,
  CreateJudgmentRequest,
  CreateQuestionRequest,
  decodeRouteId,
  RunCheckRequest,
  SignInRequest,
  SignUpRequest,
  SupersedeFactRequest,
} from "@ghostping/contracts"
import {
  BusinessRepository,
  BusinessRepositoryLive,
  CheckRunRepository,
  CheckRunRepositoryLive,
  ClaimRepository,
  ClaimRepositoryLive,
  FactRepository,
  FactRepositoryLive,
  JudgmentRepository,
  JudgmentRepositoryLive,
  ObservationRepository,
  ObservationRepositoryLive,
  ProductReadRepository,
  ProductReadRepositoryLive,
  QuestionRepository,
  QuestionRepositoryLive,
} from "@ghostping/db"
import { AuthorityError } from "@ghostping/db"
import {
  assertLinearLineage,
  assembleCitationEvidence,
  citationEvidenceForObservation,
  FactLineageForked,
  issueStateOf,
  loadIssueDetail,
  loadRepresentationDetail,
  loadRepresentations,
} from "./reads.js"
import {
  clearedCookieHeader,
  hashPassword,
  parseCookies,
  SESSION_COOKIE,
  sessionCookieHeader,
  verifyPassword,
} from "./auth.js"

const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  HttpServerResponse.json(body, { status, headers })

const readJson = Effect.flatMap(
  HttpServerRequest.HttpServerRequest,
  (req) => req.json as Effect.Effect<unknown>,
)

// Decode an untrusted request body through Effect Schema. On success the
// validated typed input flows to the service; on failure the caller must
// return a deterministic 4xx (never 500, never partial persistence).
const decodeRequest = <A, I>(schema: Schema.Schema<A, I>, raw: unknown): A | null => {
  const parsed = Schema.decodeUnknownEither(schema)(raw)
  return parsed._tag === "Right" ? parsed.right : null
}

const malformed = { _tag: "InvalidFactValue", reason: "malformed request" } as const

// Repository-managed businesses reject hosted fact writes with a typed
// defect; surface it as 409 (expected authority conflict), never 500.
const authorityConflict = (e: unknown) =>
  e instanceof AuthorityError
    ? json(409, { _tag: "FactAuthorityManagedByRepository", reason: e instanceof Error ? e.message : "repository-managed" })
    : Effect.die(e)

// Route identifiers are externally supplied: validate before any repository
// operation so malformed ids become 4xx, never opaque SQL errors.
const isRouteId = (id: string): boolean => decodeRouteId(id)._tag === "Right"

const sessionOf = (req: {
  headers: { [k: string]: string | undefined } | Headers
}): string | null => {
  const raw =
    typeof (req.headers as Record<string, string | undefined>)["cookie"] === "string"
      ? ((req.headers as Record<string, string | undefined>)["cookie"] as string)
      : (req.headers instanceof Headers ? req.headers.get("cookie") : null)
  return parseCookies(raw).hasOwnProperty(SESSION_COOKIE)
    ? (parseCookies(raw)[SESSION_COOKIE] as string)
    : null
}

interface Session {
  readonly userId: string
  readonly accountId: string
}

// Claims joined to their observation and the head of their judgment chain.
const CLAIMS_CTE = `
  WITH claim_rows AS (
    SELECT c.id AS claim_id, o.provider, o.collected_at, cr.question_id, j.id AS judgment_id,
           COALESCE(j.verdict, 'UNREVIEWED') AS verdict
    FROM candidate_claims c
    JOIN observations o ON o.id = c.observation_id
    LEFT JOIN check_runs cr ON cr.id = o.check_run_id
    LEFT JOIN human_judgments j ON j.claim_id = c.id
      AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id)
    WHERE c.business_id = $1
  )`

const verdictCounts = (where: string) => `
  count(*) FILTER (WHERE ${where} AND verdict = 'SUPPORTED')::int AS supported,
  count(*) FILTER (WHERE ${where} AND verdict = 'CONTRADICTED')::int AS wrong,
  count(*) FILTER (WHERE ${where} AND verdict = 'PARTIAL')::int AS partial,
  count(*) FILTER (WHERE ${where} AND verdict = 'INSUFFICIENT_EVIDENCE')::int AS unknown,
  count(*) FILTER (WHERE ${where} AND verdict = 'UNREVIEWED')::int AS unreviewed`

const loadAnalytics = async (pool: pg.Pool, businessId: string, days: number) => {
  const now = new Date()
  const start = new Date(now.getTime() - days * 86_400_000)
  const prevStart = new Date(start.getTime() - days * 86_400_000)
  const args = [businessId, start.toISOString(), prevStart.toISOString()]

  const [runTotals, claimTotals, daily, providers, questions, facts] = await Promise.all([
    pool.query(
      `SELECT
         count(*) FILTER (WHERE queued_at >= $2)::int AS checks,
         count(*) FILTER (WHERE queued_at >= $2 AND status = 'SUCCEEDED')::int AS succeeded,
         count(*) FILTER (WHERE queued_at >= $2 AND status = 'FAILED')::int AS failed,
         count(*) FILTER (WHERE queued_at >= $3 AND queued_at < $2)::int AS prev_checks,
         count(*) FILTER (WHERE queued_at >= $3 AND queued_at < $2 AND status = 'SUCCEEDED')::int AS prev_succeeded
       FROM check_runs WHERE business_id = $1`,
      args,
    ),
    pool.query(
      `${CLAIMS_CTE}
       SELECT ${verdictCounts("collected_at >= $2")},
              ${verdictCounts("collected_at >= $3 AND collected_at < $2").replace(/ AS (\w+)/g, " AS prev_$1")}
       FROM claim_rows`,
      args,
    ),
    pool.query(
      `${CLAIMS_CTE},
       day_series AS (SELECT generate_series(($2::timestamptz AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date, interval '1 day')::date AS day),
       runs AS (
         SELECT (queued_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS checks,
                count(*) FILTER (WHERE status = 'FAILED')::int AS failed
         FROM check_runs WHERE business_id = $1 AND queued_at >= $2 GROUP BY 1
       ),
       claims AS (
         SELECT (collected_at AT TIME ZONE 'UTC')::date AS day, ${verdictCounts("true")}
         FROM claim_rows WHERE collected_at >= $2 GROUP BY 1
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
              COALESCE(r.checks, 0) AS checks, COALESCE(r.failed, 0) AS failed,
              COALESCE(c.supported, 0) AS supported, COALESCE(c.wrong, 0) AS wrong, COALESCE(c.partial, 0) AS partial,
              COALESCE(c.unknown, 0) AS unknown, COALESCE(c.unreviewed, 0) AS unreviewed
       FROM day_series d LEFT JOIN runs r ON r.day = d.day LEFT JOIN claims c ON c.day = d.day
       ORDER BY d.day`,
      args.slice(0, 2),
    ),
    pool.query(
      `${CLAIMS_CTE},
       answers AS (
         SELECT provider, count(*)::int AS answers FROM observations
         WHERE business_id = $1 AND collected_at >= $2 GROUP BY provider
       ),
       claims AS (SELECT provider, ${verdictCounts("true")} FROM claim_rows WHERE collected_at >= $2 GROUP BY provider)
       SELECT COALESCE(a.provider, c.provider) AS provider, COALESCE(a.answers, 0) AS answers,
              COALESCE(c.supported, 0) AS supported, COALESCE(c.wrong, 0) AS wrong, COALESCE(c.partial, 0) AS partial,
              COALESCE(c.unknown, 0) AS unknown, COALESCE(c.unreviewed, 0) AS unreviewed
       FROM answers a FULL OUTER JOIN claims c ON c.provider = a.provider
       ORDER BY answers DESC`,
      args.slice(0, 2),
    ),
    pool.query(
      `${CLAIMS_CTE}
       SELECT q.id, q.prompt, q.label,
              (SELECT count(*)::int FROM check_runs r WHERE r.question_id = q.id AND r.queued_at >= $2) AS checks,
              (SELECT max(o.collected_at) FROM observations o JOIN check_runs r ON r.id = o.check_run_id WHERE r.question_id = q.id) AS last_checked_at,
              ${verdictCounts("cr.collected_at >= $2")}
       FROM buyer_questions q
       LEFT JOIN claim_rows cr ON cr.question_id = q.id
       WHERE q.business_id = $1
       GROUP BY q.id
       ORDER BY wrong DESC, partial DESC, checks DESC`,
      args.slice(0, 2),
    ),
    pool.query(
      `${CLAIMS_CTE}
       SELECT f.id, f.predicate, f.value_text, f.status, ${verdictCounts("true")}
       FROM claim_rows cr
       JOIN human_judgment_facts hjf ON hjf.judgment_id = cr.judgment_id
       JOIN authoritative_facts f ON f.id = hjf.fact_id
       WHERE cr.collected_at >= $2
       GROUP BY f.id
       ORDER BY wrong DESC, partial DESC`,
      args.slice(0, 2),
    ),
  ])

  const rt = runTotals.rows[0] as Record<string, number>
  const ct = claimTotals.rows[0] as Record<string, number>
  return {
    range: { days, from: start.toISOString(), to: now.toISOString() },
    current: {
      checks: rt["checks"] ?? 0,
      answers: rt["succeeded"] ?? 0,
      failed: rt["failed"] ?? 0,
      supported: ct["supported"] ?? 0,
      wrong: ct["wrong"] ?? 0,
      partial: ct["partial"] ?? 0,
      unknown: ct["unknown"] ?? 0,
      unreviewed: ct["unreviewed"] ?? 0,
    },
    previous: {
      checks: rt["prev_checks"] ?? 0,
      answers: rt["prev_succeeded"] ?? 0,
      supported: ct["prev_supported"] ?? 0,
      wrong: ct["prev_wrong"] ?? 0,
      partial: ct["prev_partial"] ?? 0,
      unknown: ct["prev_unknown"] ?? 0,
      unreviewed: ct["prev_unreviewed"] ?? 0,
    },
    daily: daily.rows,
    providers: providers.rows,
    questions: questions.rows.map((r: Record<string, unknown>) => ({
      ...r,
      last_checked_at: r["last_checked_at"] ? new Date(r["last_checked_at"] as string).toISOString() : null,
    })),
    facts: facts.rows,
  }
}

// Direct pg pool for auth/session lookups (small, explicit; repositories own the rest).
const getSession = (pool: pg.Pool, sessionId: string): Promise<Session | null> =>
  pool
    .query(`SELECT user_id, account_id FROM sessions WHERE id = $1 AND expires_at > now()`, [sessionId])
    .then((r) => {
      const row = r.rows[0] as { user_id: string; account_id: string } | undefined
      return row ? { userId: row.user_id, accountId: row.account_id } : null
    })

const requireSession = (pool: pg.Pool) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (req) => {
    const sid = sessionOf(req as unknown as { headers: Record<string, string | undefined> })
    if (!sid) return Effect.fail({ _tag: "NotAuthenticated" as const })
    return Effect.tryPromise({
      try: () => getSession(pool, sid),
      catch: () => ({ _tag: "Unknown" as const }),
    }).pipe(
      Effect.flatMap((s) => (s ? Effect.succeed({ session: s, sessionId: sid }) : Effect.fail({ _tag: "NotAuthenticated" as const }))),
    )
  })

export const makeRouter = (pool: pg.Pool) => {
  const router = HttpRouter.empty

  const withSession = <A, E, R>(
    run: (session: Session) => Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E | { readonly _tag: "NotAuthenticated" } | { readonly _tag: "Unknown" },
    R | HttpServerRequest.HttpServerRequest
  > => Effect.flatMap(requireSession(pool), ({ session }) => run(session))

  const api = router.pipe(
    // ---- auth ----
    HttpRouter.post(
      "/api/auth/signup",
      Effect.gen(function*() {
        const raw = (yield* readJson) as unknown
        const body = decodeRequest(SignUpRequest, raw)
        if (!body) return yield* json(422, malformed)
        const email = String(body.email ?? "").trim().toLowerCase()
        const password = String(body.password ?? "")
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return yield* json(422, { _tag: "InvalidFactValue", reason: "bad email" })
        let passwordHash: string
        try {
          passwordHash = hashPassword(password)
        } catch {
          return yield* json(422, { _tag: "InvalidFactValue", reason: "password too short" })
        }
        const c = yield* Effect.tryPromise({
          try: async () => {
            const client = await pool.connect()
            try {
              await client.query("BEGIN")
              const accountName = String(body.accountName ?? `${email} account`)
              const a = await client.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [accountName])
              const accountId: string = a.rows[0]["id"]
              let userId: string
              try {
                const u = await client.query(`INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id`, [
                  email,
                  passwordHash,
                ])
                userId = u.rows[0]["id"]
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e)
                if (/duplicate|unique/i.test(msg)) {
                  const err = new Error("conflict") as Error & { code?: string }
                  err.code = "CONFLICT"
                  throw err
                }
                throw e
              }
              await client.query(`INSERT INTO account_users (account_id, user_id) VALUES ($1,$2)`, [accountId, userId])
              const sessionId = randomUUID()
              await client.query(
                `INSERT INTO sessions (id, user_id, account_id, expires_at) VALUES ($1,$2,$3, now() + interval '30 days')`,
                [sessionId, userId, accountId],
              )
              await client.query("COMMIT")
              return { accountId, userId, sessionId }
            } catch (e) {
              await client.query("ROLLBACK")
              throw e
            } finally {
              client.release()
            }
          },
          catch: (e) => e as unknown,
        })
        if ((c as { code?: string }).code === "CONFLICT") return yield* json(409, { _tag: "Conflict", message: "email taken" })
        const { sessionId, accountId, userId } = c as { sessionId: string; accountId: string; userId: string }
        const secure = (process.env["APP_BASE_URL"] ?? "").startsWith("https://")
        return yield* json(
          200,
          { userId, accountId },
          { "Set-Cookie": sessionCookieHeader(sessionId, secure) },
        )
      }),
    ),
    HttpRouter.post(
      "/api/auth/signin",
      Effect.gen(function*() {
        const raw = (yield* readJson) as unknown
        const body = decodeRequest(SignInRequest, raw)
        if (!body) return yield* json(422, malformed)
        const email = String(body.email ?? "").trim().toLowerCase()
        const password = String(body.password ?? "")
        const found = yield* Effect.tryPromise({
          try: () =>
            pool.query(`SELECT u.id, u.password_hash, au.account_id FROM users u JOIN account_users au ON au.user_id = u.id WHERE u.email = $1 LIMIT 1`, [email]),
          catch: () => ({ rows: [] }) as unknown as pg.QueryResult,
        })
        const row = (found as pg.QueryResult).rows[0] as
          | { id: string; password_hash: string; account_id: string }
          | undefined
        if (!row || !verifyPassword(password, row.password_hash)) {
          return yield* json(401, { _tag: "NotAuthenticated" })
        }
        const sessionId = randomUUID()
        yield* Effect.tryPromise({
          try: () =>
            pool.query(`INSERT INTO sessions (id, user_id, account_id, expires_at) VALUES ($1,$2,$3, now() + interval '30 days')`, [
              sessionId,
              row.id,
              row.account_id,
            ]),
          catch: () => undefined,
        })
        const secure = (process.env["APP_BASE_URL"] ?? "").startsWith("https://")
        return yield* json(
          200,
          { userId: row.id, accountId: row.account_id },
          { "Set-Cookie": sessionCookieHeader(sessionId, secure) },
        )
      }),
    ),
    HttpRouter.post(
      "/api/auth/signout",
      Effect.gen(function*() {
        const req = yield* HttpServerRequest.HttpServerRequest
        const sid = sessionOf(req as unknown as { headers: Record<string, string | undefined> })
        if (sid) {
          yield* Effect.tryPromise({ try: () => pool.query(`DELETE FROM sessions WHERE id = $1`, [sid]), catch: () => undefined })
        }
        return yield* json(200, { ok: true }, { "Set-Cookie": clearedCookieHeader() })
      }),
    ),
    HttpRouter.get(
      "/api/auth/me",
      Effect.gen(function*() {
        const s = yield* requireSession(pool).pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (!s) return yield* json(401, { _tag: "NotAuthenticated" })
        return yield* json(200, { userId: s.session.userId, accountId: s.session.accountId })
      }),
    ),
    // ---- businesses ----
    HttpRouter.get(
      "/api/businesses",
      withSession((session) =>
        Effect.gen(function*() {
          const repo = yield* BusinessRepository
          const rows = yield* repo.list(session.accountId)
          return yield* json(200, { businesses: rows })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.post(
      "/api/businesses",
      withSession((session) =>
        Effect.gen(function*() {
          const raw = (yield* readJson) as unknown
          const body = decodeRequest(CreateBusinessRequest, raw)
          if (!body) return yield* json(422, malformed)
          const name = body.name.trim()
          if (!name) return yield* json(422, { _tag: "InvalidFactValue", reason: "name required" })
          const repo = yield* BusinessRepository
          const row = yield* repo.create(session.accountId, name)
          return yield* json(200, { business: row })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // ---- facts ----
    HttpRouter.get(
      "/api/businesses/:id/facts",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          const scoped = yield* biz.getScoped(session.accountId, businessId)
          if (!scoped) return yield* json(404, { _tag: "BusinessNotFound" })
          const facts = yield* FactRepository
          const rows = yield* facts.listByBusiness(businessId)
          // Conflict surfacing (never auto-picks a winner; UI shows warning).
          const active = rows.filter((r) => r.status === "ACTIVE")
          const conflicts: Array<{ a: string; b: string }> = []
          for (let i = 0; i < active.length; i++) {
            for (let j = i + 1; j < active.length; j++) {
              const a = active[i] as (typeof active)[number]
              const b = active[j] as (typeof active)[number]
              if (a.subject === b.subject && a.predicate === b.predicate) {
                const as = new Date(a.validFrom).getTime()
                const ae = a.validUntil ? new Date(a.validUntil).getTime() : Infinity
                const bs = new Date(b.validFrom).getTime()
                const be = b.validUntil ? new Date(b.validUntil).getTime() : Infinity
                if (as < be && bs < ae) conflicts.push({ a: a.id, b: b.id })
              }
            }
          }
          // Authority contract: absent mode row means HOSTED (engineering
          // contract); provenance stays unknown (null) when never synced.
          const reads = yield* ProductReadRepository
          const mode = (yield* reads.authorityMode(businessId)) ?? "HOSTED"
          const provenanceRows = yield* reads.factProvenance(businessId)
          const provenance: Record<string, { manifestKey: string; manifestDigest: string; sourceRevision: string | null; syncedAt: string; sourceUrl: string | null } | null> = {}
          for (const r of rows) provenance[r.id] = null
          for (const p of provenanceRows) provenance[p.factId] = { manifestKey: p.manifestKey, manifestDigest: p.manifestDigest, sourceRevision: p.sourceRevision, syncedAt: p.syncedAt, sourceUrl: p.sourceUrl }
          return yield* json(200, { facts: rows, conflicts, authority: { mode }, provenance })
        }),
      ).pipe(
        Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown)),
        Effect.catchAllDefect(authorityConflict),
      ),
    ),
    HttpRouter.post(
      "/api/businesses/:id/facts",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          const scoped = yield* biz.getScoped(session.accountId, businessId)
          if (!scoped) return yield* json(404, { _tag: "BusinessNotFound" })
          const raw = (yield* readJson) as unknown
          const body = decodeRequest(CreateFactRequest, raw)
          if (!body) return yield* json(422, malformed)
          const subject = body.subject.trim()
          const predicate = body.predicate.trim()
          const valueText = body.valueText
          const valueType = body.valueType
          const validFrom = body.validFrom
          const validUntil = body.validUntil ?? null
          const sourceKind = body.sourceKind
          if (!subject || !predicate || !valueText.trim()) {
            return yield* json(422, { _tag: "InvalidFactValue", reason: "subject/predicate/value required" })
          }
          const facts = yield* FactRepository
          const overlapping = yield* facts.activeOverlapping({
            businessId,
            subject,
            predicate,
            validFrom,
            validUntil,
          })
          if (overlapping.length > 0) {
            return yield* json(422, {
              _tag: "FactAuthorityConflict",
              conflicts: overlapping.map((o) => ({ predicate, valueText: o.valueText, id: o.id })),
            })
          }
          const row = yield* facts.create({
            businessId,
            subject,
            predicate,
            valueText,
            valueType,
            validFrom,
            validUntil,
            sourceKind,
          })
          return yield* json(200, { fact: row })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.post(
      "/api/businesses/:id/facts/:factId/supersede",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          if (!isRouteId(p["id"] as string) || !isRouteId(p["factId"] as string)) {
            return yield* json(422, malformed)
          }
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, p["id"] as string))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const raw = (yield* readJson) as unknown
          const body = decodeRequest(SupersedeFactRequest, raw)
          if (!body) return yield* json(422, malformed)
          const facts = yield* FactRepository
          // Never mutate fact value in place: supersede creates v+1.
          const row = yield* facts.supersede({
            businessId: p["id"] as string,
            factId: p["factId"] as string,
            valueText: body.valueText,
            valueType: body.valueType,
            validFrom: body.validFrom,
            validUntil: body.validUntil ?? null,
            sourceKind: body.sourceKind,
          })
          return yield* json(200, { fact: row })
        }),
      ).pipe(
        Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown)),
        Effect.catchAllDefect(authorityConflict),
      ),
    ),
    HttpRouter.post(
      "/api/businesses/:id/facts/:factId/retire",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          if (!isRouteId(p["id"] as string) || !isRouteId(p["factId"] as string)) {
            return yield* json(422, malformed)
          }
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, p["id"] as string))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const facts = yield* FactRepository
          const row = yield* facts.retire(p["id"] as string, p["factId"] as string)
          if (!row) return yield* json(404, { _tag: "FactNotFound" })
          return yield* json(200, { fact: row })
        }),
      ).pipe(
        Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown)),
        Effect.catchAllDefect(authorityConflict),
      ),
    ),
    // ---- questions ----
    HttpRouter.get(
      "/api/businesses/:id/questions",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const q = yield* QuestionRepository
          return yield* json(200, { questions: yield* q.listByBusiness(businessId) })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.post(
      "/api/businesses/:id/questions",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const body = decodeRequest(CreateQuestionRequest, (yield* readJson) as unknown)
          if (!body) return yield* json(422, malformed)
          const prompt = body.prompt.trim()
          if (!prompt) return yield* json(422, { _tag: "InvalidFactValue", reason: "prompt required" })
          const q = yield* QuestionRepository
          const row = yield* q.create({
            businessId,
            label: body.label ?? null,
            prompt,
            origin: body.origin,
          })
          return yield* json(200, { question: row })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // ---- check runs ----
    HttpRouter.get(
      "/api/businesses/:id/check-runs",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const runs = yield* CheckRunRepository
          const obs = yield* ObservationRepository
          const list = yield* runs.listByBusiness(businessId)
          const withObs = yield* Effect.forEach(list, (r) =>
            Effect.map(obs.getByCheckRun(r.id), (o) => ({ ...r, observationId: o?.id ?? null })),
          )
          return yield* json(200, { checkRuns: withObs })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.post(
      "/api/businesses/:id/check-runs",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const body = decodeRequest(RunCheckRequest, (yield* readJson) as unknown)
          if (!body) return yield* json(422, malformed)
          const questionId = body.questionId
          const provider = body.provider ?? "mock"
          const requestedModel = body.requestedModel ?? null
          const q = yield* QuestionRepository
          if (!(yield* q.getScoped(businessId, questionId))) return yield* json(404, { _tag: "QuestionNotFound" })
          const runs = yield* CheckRunRepository
          // Every execution creates a CheckRun QUEUED; worker claims it.
          // provider is schema-restricted to mock|9router; the 9router model
          // pin is enforced inside the Rust worker, not here.
          const row = yield* runs.enqueue({ businessId, questionId, provider, requestedModel })
          return yield* json(200, { checkRun: row })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // ---- observations ----
    HttpRouter.get(
      "/api/observations/:observationId",
      Effect.gen(function*() {
        const s = yield* requireSession(pool).pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (!s) return yield* json(401, { _tag: "NotAuthenticated" })
        const params = yield* HttpRouter.RouteContext
        const observationId = (params.params as Record<string, string>)["observationId"] as string
        if (!isRouteId(observationId)) return yield* json(422, malformed)
        const obs = yield* ObservationRepository
        // Account scoping: observation's business must belong to session account.
        const biz = yield* BusinessRepository
        const businesses = yield* biz.list(s.session.accountId)
        const ids = new Set(businesses.map((b) => b.id))
        const full = yield* Effect.tryPromise({
          try: () =>
            pool.query(
              `SELECT o.*, b.account_id FROM observations o JOIN businesses b ON b.id = o.business_id WHERE o.id = $1`,
              [observationId],
            ),
          catch: () => ({ rows: [] }) as unknown as pg.QueryResult,
        })
        const row = (full as pg.QueryResult).rows[0] as
          | { account_id: string; business_id: string }
          | undefined
        if (!row || row.account_id !== s.session.accountId) {
          return yield* json(404, { _tag: "ObservationNotFound" })
        }
        void ids
        const claims = yield* ClaimRepository
        // Load claims for this observation + judgments for issue context.
        const allClaims = yield* Effect.tryPromise({
          try: () =>
            pool.query(`SELECT * FROM candidate_claims WHERE observation_id = $1 ORDER BY created_at ASC`, [observationId]),
          catch: () => ({ rows: [] }) as unknown as pg.QueryResult,
        })
        void obs
        void claims
        const citations = yield* citationEvidenceForObservation(s.session.accountId, String(row.business_id), observationId)
        return yield* json(200, {
          observation: (yield* Effect.tryPromise({
            try: () =>
              pool
                .query(
                  `SELECT o.*, r.content_text AS raw_text FROM observations o JOIN raw_evidence r ON r.id = o.raw_evidence_id WHERE o.id = $1`,
                  [observationId],
                )
                .then((r) => r.rows[0]),
            catch: () => null,
          })) as unknown,
          claims: (allClaims as pg.QueryResult).rows,
          // Provider-returned citations exactly as stored, with tracked
          // representation matches where canonical URLs agree.
          citations: citations ?? [],
        })
      }),
    ),
    // ---- claims ----
    HttpRouter.post(
      "/api/claims",
      withSession((session) =>
        Effect.gen(function*() {
          const body = decodeRequest(CreateClaimRequest, (yield* readJson) as unknown)
          if (!body) return yield* json(422, malformed)
          const observationId = body.observationId
          const text = body.text.trim()
          if (!text) return yield* json(422, { _tag: "InvalidFactValue", reason: "claim text required" })
          const found = yield* Effect.tryPromise({
            try: () =>
              pool.query(
                `SELECT o.business_id, b.account_id FROM observations o JOIN businesses b ON b.id = o.business_id WHERE o.id = $1`,
                [observationId],
              ),
            catch: () => ({ rows: [] }) as unknown as pg.QueryResult,
          })
          const r = (found as pg.QueryResult).rows[0] as
            | { business_id: string; account_id: string }
            | undefined
          if (!r || r.account_id !== session.accountId) return yield* json(404, { _tag: "ObservationNotFound" })
          const claims = yield* ClaimRepository
          // Manual transcription only; no automatic extraction, no invented offsets.
          const row = yield* claims.create({
            businessId: r.business_id,
            observationId,
            text,
            origin: "MANUAL_TRANSCRIPTION",
          })
          return yield* json(200, { claim: row })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // ---- judgments ----
    HttpRouter.post(
      "/api/judgments",
      withSession((session) =>
        Effect.gen(function*() {
          const body = decodeRequest(CreateJudgmentRequest, (yield* readJson) as unknown)
          if (!body) return yield* json(422, malformed)
          const claimId = body.claimId
          const verdict = body.verdict
          const found = yield* Effect.tryPromise({
            try: () =>
              pool.query(
                `SELECT c.business_id, b.account_id FROM candidate_claims c JOIN businesses b ON b.id = c.business_id WHERE c.id = $1`,
                [claimId],
              ),
            catch: () => ({ rows: [] }) as unknown as pg.QueryResult,
          })
          const r = (found as pg.QueryResult).rows[0] as
            | { business_id: string; account_id: string }
            | undefined
          if (!r || r.account_id !== session.accountId) return yield* json(404, { _tag: "ClaimNotFound" })
          const judgments = yield* JudgmentRepository
          const row = yield* judgments.create({
            businessId: r.business_id,
            claimId,
            verdict,
            notes: body.notes ?? null,
            factIds: body.factIds,
          })
          return yield* json(200, { judgment: row })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // ---- issues (derived) ----
    HttpRouter.get(
      "/api/businesses/:id/issues",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const reads = yield* ProductReadRepository
          const rows = yield* reads.issueList(businessId)
          const issues: Array<Record<string, unknown>> = rows
            .map((r) => ({ ...r, state: issueStateOf(r["verdict"] as string | null) }))
            .filter((r) => (r["state"] as string) !== "RESOLVED")
          // Batched citation evidence: one representation load for the whole
          // inbox, matched per issue observation (never one query per issue).
          const representations = (yield* loadRepresentations(session.accountId, businessId)) ?? []
          const reads = yield* ProductReadRepository
          const allCitations = yield* reads.aiCitations(businessId)
          const byObservation = new Map<string, Array<Record<string, unknown>>>()
          for (const c of allCitations) {
            const key = String(c["observation_id"])
            const arr = byObservation.get(key) ?? []
            arr.push(c)
            byObservation.set(key, arr)
          }
          const withEvidence = issues.map((issue) => ({
            ...issue,
            citation_evidence: assembleCitationEvidence(
              (byObservation.get(String(issue["observation_id"])) ?? []).map((c) => ({
                uri: (c["uri"] as string | null) ?? null,
                title: (c["title"] as string | null) ?? null,
                position: (c["position"] as number | null) ?? null,
                attributed: Boolean(c["attributed"]),
              })),
              representations,
            ),
          }))
          return yield* json(200, { issues: withEvidence })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    // ---- analytics (derived, read-only) ----
    // Counts and breakdowns only: no composite scores. Claim verdicts use the
    // head of each judgment chain, the same rule as the issues inbox. Days are
    // bucketed in UTC (the V1 normalization convention).
    HttpRouter.get(
      "/api/businesses/:id/analytics",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const req = yield* HttpServerRequest.HttpServerRequest
          const daysParam = new URL(req.url, "http://localhost").searchParams.get("days") ?? "30"
          const days = Number(daysParam)
          if (!Number.isInteger(days) || days < 1 || days > 365) return yield* json(422, malformed)

          const data = yield* Effect.tryPromise({
            try: () => loadAnalytics(pool, businessId, days),
            catch: () => ({ _tag: "Unknown" as const }),
          })
          return yield* json(200, { analytics: data })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.get(
      "/api/businesses/:id/overview",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const counts = yield* Effect.tryPromise({
            try: () =>
              pool.query(
                `SELECT
                   (SELECT count(*) FROM check_runs WHERE business_id = $1 AND status = 'SUCCEEDED') AS completed,
                   (SELECT max(o.collected_at) FROM observations o WHERE o.business_id = $1) AS last_checked,
                   (SELECT count(*) FROM candidate_claims c LEFT JOIN human_judgments j ON j.claim_id = c.id AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id) WHERE c.business_id = $1 AND j.id IS NULL) AS unreviewed,
                   (SELECT count(*) FROM candidate_claims c JOIN human_judgments j ON j.claim_id = c.id AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id) WHERE c.business_id = $1 AND j.verdict IN ('CONTRADICTED','PARTIAL','INSUFFICIENT_EVIDENCE')) AS needs_attention`,
                [businessId],
              ),
            catch: () => ({ rows: [{}] }) as unknown as pg.QueryResult,
          })
          return yield* json(200, { overview: (counts as pg.QueryResult).rows[0] })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
  )
  // Product Surface V1 reads live in a second pipe: HttpRouter pipe
  // overloads cap a single chain, so new routes concatenate instead of
  // extending the original chain past its arity limit.
  const productApi = router.pipe(
    HttpRouter.get(
      "/api/businesses/:id/representations",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const businessId = (params.params as Record<string, string>)["id"] as string
          if (!isRouteId(businessId)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, businessId))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          return yield* json(200, { representations: yield* loadRepresentations(session.accountId, businessId) })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.get(
      "/api/businesses/:id/representations/:bindingId",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          if (!isRouteId(p["id"] as string)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, p["id"] as string))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const detail = yield* loadRepresentationDetail(session.accountId, p["id"] as string, p["bindingId"] as string)
          if (!detail) return yield* json(404, { _tag: "RepresentationNotFound" })
          return yield* json(200, detail)
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.get(
      "/api/businesses/:id/issues/:claimId",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          if (!isRouteId(p["id"] as string)) return yield* json(422, malformed)
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, p["id"] as string))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const detail = yield* loadIssueDetail(session.accountId, p["id"] as string, p["claimId"] as string)
          if (!detail) return yield* json(404, { _tag: "IssueNotFound" })
          return yield* json(200, detail)
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
    HttpRouter.get(
      "/api/businesses/:id/facts/:factId/history",
      withSession((session) =>
        Effect.gen(function*() {
          const params = yield* HttpRouter.RouteContext
          const p = params.params as Record<string, string>
          if (!isRouteId(p["id"] as string) || !isRouteId(p["factId"] as string)) {
            return yield* json(422, malformed)
          }
          const biz = yield* BusinessRepository
          if (!(yield* biz.getScoped(session.accountId, p["id"] as string))) {
            return yield* json(404, { _tag: "BusinessNotFound" })
          }
          const facts = yield* FactRepository
          const fact = yield* facts.getScoped(p["id"] as string, p["factId"] as string)
          if (!fact) return yield* json(404, { _tag: "FactNotFound" })
          const reads = yield* ProductReadRepository
          // Authority history follows supersedes_id lineage, not mutable
          // subject/predicate metadata. Forks fail closed, never flattened.
          const lineage = yield* reads.factLineage(p["id"] as string, p["factId"] as string)
          let ordered: ReadonlyArray<Record<string, unknown>>
          try {
            const checked = assertLinearLineage(
              lineage.map((r) => ({ id: String(r["id"]), supersedes_id: (r["supersedes_id"] as string | null) ?? null, version: Number(r["version"]) })),
            )
            const byId = new Map(checked.map((c) => [c.id, c]))
            ordered = lineage
              .filter((r) => byId.has(String(r["id"])))
              .sort((a, b) => Number(a["version"]) - Number(b["version"]))
          } catch (e) {
            if (e instanceof FactLineageForked) return yield* json(500, { _tag: "FactLineageForked", reason: e.message })
            throw e
          }
          // Each version keeps its own provenance; never retrofitted.
          const provenance = yield* reads.factProvenance(p["id"] as string)
          const provenanceByFact = new Map(provenance.map((r) => [r.factId, r] as const))
          return yield* json(200, {
            fact,
            history: ordered.map((r) => ({ ...(r as Record<string, unknown>), provenance: provenanceByFact.get(String(r["id"])) ?? null })),
          })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
    ),
  )
  return HttpRouter.concat(api, productApi)
}

export const RepoLayers = {
  BusinessRepositoryLive,
  FactRepositoryLive,
  QuestionRepositoryLive,
  CheckRunRepositoryLive,
  ObservationRepositoryLive,
  ClaimRepositoryLive,
  JudgmentRepositoryLive,
  ProductReadRepositoryLive,
}
