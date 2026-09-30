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
  QuestionRepository,
  QuestionRepositoryLive,
} from "@ghostping/db"
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
          return yield* json(200, { facts: rows, conflicts })
        }),
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
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
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
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
      ).pipe(Effect.catchAll((e) => json((e as { _tag?: string })?._tag === "NotAuthenticated" ? 401 : 500, e as unknown))),
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
          if (provider !== "mock") return yield* json(422, { _tag: "InvalidFactValue", reason: "only mock provider in V1" })
          const q = yield* QuestionRepository
          if (!(yield* q.getScoped(businessId, questionId))) return yield* json(404, { _tag: "QuestionNotFound" })
          const runs = yield* CheckRunRepository
          // Every execution creates a CheckRun QUEUED; worker claims it.
          const row = yield* runs.enqueue({ businessId, questionId, provider, requestedModel: null })
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
          const data = yield* Effect.tryPromise({
            try: () =>
              pool.query(
                `SELECT c.id AS claim_id, c.text AS claim_text, c.observation_id, o.answer_text, o.provider, o.observed_model, o.collected_at,
                        q.prompt AS question_prompt,
                        j.id AS judgment_id, j.verdict, j.notes,
                        COALESCE((SELECT json_agg(json_build_object('id', f.id, 'predicate', f.predicate, 'valueText', f.value_text, 'status', f.status) ORDER BY f.predicate)
                          FROM human_judgment_facts hjf JOIN authoritative_facts f ON f.id = hjf.fact_id WHERE hjf.judgment_id = j.id), '[]'::json) AS facts
                 FROM candidate_claims c
                 JOIN observations o ON o.id = c.observation_id
                 LEFT JOIN check_runs cr ON cr.id = o.check_run_id
                 LEFT JOIN buyer_questions q ON q.id = cr.question_id
                 LEFT JOIN human_judgments j ON j.claim_id = c.id AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id)
                 WHERE c.business_id = $1 ORDER BY c.created_at DESC`,
                [businessId],
              ),
            catch: () => ({ rows: [] }) as unknown as pg.QueryResult,
          })
          const issues = ((data as pg.QueryResult).rows as Array<Record<string, unknown>>)
            .map((r) => {
              const verdict = r["verdict"] as string | null
              const state =
                verdict === "CONTRADICTED"
                  ? "WRONG"
                  : verdict === "PARTIAL"
                    ? "PARTIAL"
                    : verdict === "INSUFFICIENT_EVIDENCE"
                      ? "UNKNOWN"
                      : verdict === "SUPPORTED"
                        ? "RESOLVED"
                        : "NEEDS_REVIEW"
              return { ...r, state }
            })
            .filter((r) => (r["state"] as string) !== "RESOLVED")
          return yield* json(200, { issues })
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
  return api
}

export const RepoLayers = {
  BusinessRepositoryLive,
  FactRepositoryLive,
  QuestionRepositoryLive,
  CheckRunRepositoryLive,
  ObservationRepositoryLive,
  ClaimRepositoryLive,
  JudgmentRepositoryLive,
}
