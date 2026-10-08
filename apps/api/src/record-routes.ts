// Client record HTTP surface. Operator routes are session-scoped to the
// agency account; every human act is attributed to the session user and
// request bodies never carry identities. The one public route serves the
// explicit public projection for an ACTIVE share id and answers the same
// 404 for malformed, unknown and revoked ids.
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import type { SqlError } from "@effect/sql/SqlError"
import { Config, Effect, Schema } from "effect"
import { AuthRepository, BusinessRepository, operatorView, publicRecord, RecordRepository, type RecordRefused, type RowDecodeError, type Session } from "@openrecord/db"
import { decodeRouteId } from "@openrecord/contracts"

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => HttpServerResponse.json(body, { status, headers })
const readJson = Effect.flatMap(HttpServerRequest.HttpServerRequest, req => req.json).pipe(Effect.catchAll(() => Effect.succeed(null)))
const decode = <A, I>(schema: Schema.Schema<A, I>, raw: unknown): A | null => {
  const decoded = Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(raw)
  return decoded._tag === "Right" ? decoded.right : null
}

const Text = (max: number) => Schema.String.pipe(Schema.maxLength(max), Schema.filter(s => s.trim().length > 0, { message: () => "required" }))
/** Absolute http(s) URL without credentials. */
export const PublicUrl = Schema.String.pipe(Schema.maxLength(2000), Schema.filter(s => {
  try {
    const u = new URL(s)
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !/\s/.test(s)
  } catch { return false }
}, { message: () => "http(s) URL required" }))
const IsoTime = Schema.String.pipe(Schema.filter(s => !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}/.test(s), { message: () => "ISO timestamp required" }))

const CreateClientRequest = Schema.Struct({ name: Text(200), websiteUrl: PublicUrl, engagement: Schema.optional(Schema.Literal("CLIENT", "DOGFOOD", "FIXTURE")) })
const UpdateClientRequest = Schema.Struct({ name: Text(200), websiteUrl: PublicUrl })
const SaveSlotRequest = Schema.Struct({
  subject: Text(200), predicate: Text(200), valueText: Text(500),
  valueType: Schema.Literal("TEXT", "NUMBER", "CURRENCY", "BOOLEAN", "DATE", "URL", "ENUM"),
  validFrom: Schema.optional(IsoTime), validUntil: Schema.optional(Schema.NullOr(IsoTime)),
  sourceUrl: PublicUrl, question: Text(500),
})
const StartRunRequest = Schema.Struct({ kind: Schema.optional(Schema.Literal("INITIAL", "FOLLOW_UP")) })
const JudgeRequest = Schema.Struct({ observationId: Schema.UUID, decision: Schema.Literal("MATCHES", "CONTRADICTS", "UNKNOWN"), note: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(2000)))) })
const ActionRequest = Schema.Struct({
  slot: Schema.NullOr(Schema.Literal(1, 2, 3)),
  type: Schema.optional(Schema.Literal("SOURCE_UPDATED", "SOURCE_PUBLISHED", "STRUCTURED_DATA_UPDATED", "THIRD_PARTY_CORRECTION_REQUESTED", "OTHER")),
  note: Text(500), links: Schema.optional(Schema.Array(PublicUrl).pipe(Schema.maxItems(5))), performedAt: Schema.optional(IsoTime),
})

/** The single live surface the commercial record uses, from configuration. */
export const RecordSurfaceConfig = Config.all({
  provider: Config.literal("gemini", "mock")("RECORD_PROVIDER").pipe(Config.withDefault("gemini" as const)),
  model: Config.string("GEMINI_MODEL").pipe(Config.withDefault("gemini-2.5-flash")),
})
/** Fixture observations are only for tests and explicit local demos. */
export const recordFixtureAllowed = () => process.env["NODE_ENV"] === "test" || process.env["RECORD_ALLOW_FIXTURE"] === "1"

const PUBLIC_ID = /^[A-Za-z0-9_-]{43}$/
/** A capability URL: never cached, never indexed, never leaked via Referer. */
const PUBLIC_HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" }

type WithSession = <A, E, R>(run: (session: Session) => Effect.Effect<A, E, R>) =>
  Effect.Effect<A, E | SqlError | RowDecodeError | { readonly _tag: "NotAuthenticated" }, R | AuthRepository | HttpServerRequest.HttpServerRequest>

const failure = (e: unknown) => {
  const tag = (e as { _tag?: string })?._tag
  if (tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" })
  if (tag === "RecordRefused") {
    const reason = (e as RecordRefused).reason
    return json(reason.endsWith("NotFound") ? 404 : 409, { _tag: "RecordRefused", reason })
  }
  // Concurrent duplicate writes lose on a unique index; report a conflict,
  // never a database message.
  if (tag === "SqlError" && /duplicate key|unique/i.test(String((e as { cause?: unknown }).cause ?? ""))) return json(409, { _tag: "RecordRefused", reason: "Conflict" })
  return json(500, { _tag: "RecordRequestFailed" })
}

export const recordApi = (withSession: WithSession) => {
  // SameSite cookies do not isolate a hostile sibling subdomain. Browser
  // writes must come from the configured application origin. Non-browser
  // clients without Origin still need their authenticated session.
  const operatorSession = <E, R>(run: (s: Session) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== "GET" && request.method !== "HEAD") {
        const origin = request.headers["origin"]
        const app = yield* Config.string("APP_BASE_URL").pipe(Config.withDefault("http://localhost:3000"))
        let allowed = false
        try { allowed = origin === new URL(app).origin } catch { /* bad configuration fails closed */ }
        if ((origin !== undefined && !allowed) || (origin === undefined && ["cross-site", "same-site"].includes(request.headers["sec-fetch-site"] ?? ""))) {
          return yield* json(403, { _tag: "OriginRefused" })
        }
      }
      return yield* withSession(run)
    })
  /** Business scoped to the session's agency account and carrying a record profile. */
  const client = <E, R>(run: (s: Session, businessId: string, p: Record<string, string>) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operatorSession((session: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const p = params as Record<string, string>
      for (const key of ["id", "itemId"]) if (p[key] !== undefined && decodeRouteId(p[key])._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" })
      const business = yield* (yield* BusinessRepository).getScoped(session.accountId, p["id"]!)
      if (!business) return yield* json(404, { _tag: "ClientNotFound" })
      return yield* run(session, business.id, p)
    })).pipe(Effect.catchAll(failure))
  const view = (businessId: string) => Effect.gen(function*() {
    const snapshot = yield* (yield* RecordRepository).snapshot(businessId)
    if (snapshot === null) return yield* json(404, { _tag: "ClientNotFound" })
    const surface = yield* RecordSurfaceConfig
    return yield* json(200, { record: operatorView(snapshot), surface: { provider: surface.provider, model: surface.model } })
  })

  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/record/clients", withSession(session => Effect.gen(function*() {
      const clients = yield* (yield* RecordRepository).listClients(session.accountId)
      return yield* json(200, { clients })
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.post("/api/record/clients", operatorSession(session => Effect.gen(function*() {
      const body = decode(CreateClientRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      if (body.engagement === "FIXTURE" && !recordFixtureAllowed()) return yield* json(422, { _tag: "FixtureDisabled" })
      const client = yield* (yield* RecordRepository).createClient(session, { name: body.name.trim(), websiteUrl: body.websiteUrl, engagement: body.engagement ?? "CLIENT" })
      return yield* json(200, { client })
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.get("/api/record/clients/:id", client((_, businessId) => view(businessId))),
    HttpRouter.put("/api/record/clients/:id", client((_, businessId) => Effect.gen(function*() {
      const body = decode(UpdateClientRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      yield* (yield* RecordRepository).updateClient(businessId, { name: body.name.trim(), websiteUrl: body.websiteUrl })
      return yield* view(businessId)
    }))),
    HttpRouter.put("/api/record/clients/:id/slots/:slot", client((session, businessId, p) => Effect.gen(function*() {
      const slot = Number(p["slot"])
      const body = decode(SaveSlotRequest, yield* readJson)
      if (!body || (slot !== 1 && slot !== 2 && slot !== 3)) return yield* json(422, { _tag: "InvalidRequest" })
      const validFrom = body.validFrom === undefined ? undefined : new Date(body.validFrom).toISOString()
      const validUntil = body.validUntil === undefined ? undefined : body.validUntil === null ? null : new Date(body.validUntil).toISOString()
      if (validFrom !== undefined && validUntil != null && Date.parse(validUntil) <= Date.parse(validFrom)) return yield* json(422, { _tag: "InvalidRequest", reason: "validUntil must follow validFrom" })
      const item = yield* (yield* RecordRepository).saveSlot(session, businessId, {
        slot, subject: body.subject.trim(), predicate: body.predicate.trim(), valueText: body.valueText.trim(), valueType: body.valueType,
        ...(validFrom === undefined ? {} : { validFrom }), ...(validUntil === undefined ? {} : { validUntil }), sourceUrl: body.sourceUrl, question: body.question.trim(),
      })
      return yield* json(200, { item })
    }))),
    HttpRouter.post("/api/record/clients/:id/items/:itemId/approve", client((session, businessId, p) => Effect.gen(function*() {
      yield* (yield* RecordRepository).approveItem(session, businessId, p["itemId"]!)
      return yield* view(businessId)
    }))),
    HttpRouter.post("/api/record/clients/:id/runs", client((session, businessId) => Effect.gen(function*() {
      const body = decode(StartRunRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const surface = yield* RecordSurfaceConfig
      if (surface.provider === "mock" && !recordFixtureAllowed()) return yield* json(409, { _tag: "RecordRefused", reason: "FixtureProviderDisabled" })
      const run = yield* (yield* RecordRepository).startRun(session, businessId, { kind: body.kind ?? null, provider: surface.provider, requestedModel: surface.provider === "gemini" ? surface.model : null })
      return yield* json(200, { run })
    }))),
    HttpRouter.post("/api/record/clients/:id/judgments", client((session, businessId) => Effect.gen(function*() {
      const body = decode(JudgeRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const note = body.note?.trim() ? body.note.trim() : null
      const judgment = yield* (yield* RecordRepository).judge(session, businessId, { observationId: body.observationId, decision: body.decision, note })
      return yield* json(200, { judgment })
    }))),
    HttpRouter.post("/api/record/clients/:id/actions", client((session, businessId) => Effect.gen(function*() {
      const body = decode(ActionRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const performedAt = new Date(body.performedAt ?? Date.now()).toISOString()
      if (Date.parse(performedAt) > Date.now() + 5 * 60_000) return yield* json(422, { _tag: "InvalidRequest", reason: "performedAt is in the future" })
      const action = yield* (yield* RecordRepository).recordAction(session, businessId, {
        slot: body.slot, type: body.type ?? "SOURCE_UPDATED", note: body.note.trim(), links: body.links ?? [], performedAt,
      })
      return yield* json(200, { action })
    }))),
    HttpRouter.post("/api/record/clients/:id/share", client((session, businessId) => Effect.gen(function*() {
      const share = yield* (yield* RecordRepository).share(session, businessId)
      return yield* json(200, { share })
    }))),
    HttpRouter.post("/api/record/clients/:id/share/revoke", client((session, businessId) => Effect.gen(function*() {
      yield* (yield* RecordRepository).revokeShare(session, businessId)
      return yield* json(200, { revoked: true })
    }))),
    HttpRouter.get("/api/public/records/:publicId", Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const publicId = (params as Record<string, string>)["publicId"] ?? ""
      const notFound = json(404, { _tag: "RecordNotFound" }, PUBLIC_HEADERS)
      if (!PUBLIC_ID.test(publicId)) return yield* notFound
      const records = yield* RecordRepository
      const businessId = yield* records.businessForPublicId(publicId)
      if (businessId === null) return yield* notFound
      const snapshot = yield* records.snapshot(businessId)
      if (snapshot === null || snapshot.share?.publicId !== publicId) return yield* notFound
      // Recheck after loading evidence so a revoke during the snapshot
      // cannot disclose the record under its old capability.
      if (yield* records.businessForPublicId(publicId).pipe(Effect.map(id => id === null))) return yield* notFound
      return yield* json(200, { record: publicRecord(snapshot) }, PUBLIC_HEADERS)
    }).pipe(Effect.catchAll(() => json(500, { _tag: "RecordUnavailable" }, PUBLIC_HEADERS)))),
  )
}
