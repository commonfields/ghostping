import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import type { SqlError } from "@effect/sql/SqlError"
import { Effect, Schema } from "effect"
import { AssayRepository, AssayReviewRepository, AuthRepository, BusinessRepository, QuestionRepository, type Session, type RowDecodeError } from "@openrecord/db"
import { RegisterAssaySourceRequest, RunAssayRequest, ReviewAssayFactRequest, RetractAssayFactRequest, ReviewAssayFindingRequest, decodeRouteId } from "@openrecord/contracts"
import { normalizeUrl } from "@openrecord/representation"

const json = (status: number, body: unknown) => HttpServerResponse.json(body, { status })
export const decodeAssayRequest = <A, I>(schema: Schema.Schema<A, I>, raw: unknown) => {
  const decoded = Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(raw)
  return decoded._tag === "Right" ? decoded.right : null
}
const readJson = Effect.flatMap(HttpServerRequest.HttpServerRequest, req => req.json).pipe(Effect.catchAll(() => Effect.succeed(null)))

type WithSession = <A, E, R>(run: (session: Session) => Effect.Effect<A, E, R>) =>
  Effect.Effect<A, E | SqlError | RowDecodeError | { readonly _tag: "NotAuthenticated" }, R | AuthRepository | HttpServerRequest.HttpServerRequest>
export const assaySyntheticEnabled = () => process.env["NODE_ENV"] === "test" || process.env["ASSAY_ALLOW_SYNTHETIC"] === "1"
export const assayApi = (withSession: WithSession) => {
  const scoped = <E, R>(run: (s: Session, p: Record<string, string>) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => withSession((session: Session) => Effect.gen(function*() {
    const { params } = yield* HttpRouter.RouteContext
    const p = params as Record<string, string>
    if (Object.values(p).some(v => decodeRouteId(v)._tag === "Left")) return yield* json(422, { _tag: "InvalidRequest" })
    const business = yield* (yield* BusinessRepository).getScoped(session.accountId, p.id!)
    if (!business) return yield* json(404, { _tag: "BusinessNotFound" })
    return yield* run(session, p)
  })).pipe(Effect.catchAll(e => {
    const unauthenticated = (e as { _tag?: string })?._tag === "NotAuthenticated"
    return json(unauthenticated ? 401 : 500, { _tag: unauthenticated ? "NotAuthenticated" : "AssayRequestFailed" })
  }))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/assay", scoped((_, p) => Effect.gen(function*() {
      const assay = yield* AssayRepository
      const sources = yield* assay.sources(p.id!)
      const groups = yield* assay.groups(p.id!)
      const facts = yield* assay.facts(p.id!)
      const findings = yield* assay.findings(p.id!)
      return yield* json(200, { sources, groups, facts, findings })
    }))),
    HttpRouter.post("/api/businesses/:id/assay/sources", scoped((session, p) => Effect.gen(function*() {
      const body = decodeAssayRequest(RegisterAssaySourceRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const url = normalizeUrl(body.url)
      if (url === null || new URL(body.url).username || new URL(body.url).password) return yield* json(422, { _tag: "InvalidSourceUrl" })
      const source = yield* (yield* AssayRepository).registerSource({ businessId: p.id!, url, subject: body.subject.trim(),
        planTerms: body.planTerms.map(s => s.trim()), capabilityTerms: body.capabilityTerms.map(s => s.trim()), requestedBy: session.userId })
      return yield* json(200, { source })
    }))),
    HttpRouter.post("/api/businesses/:id/assay/groups", scoped((_, p) => Effect.gen(function*() {
      const body = decodeAssayRequest(RunAssayRequest, yield* readJson)
      if (!body || decodeRouteId(body.questionId)._tag === "Left" || (body.provider === "9router" && !body.requestedModel)) return yield* json(422, { _tag: "InvalidRequest" })
      if (body.provider === "mock" && !assaySyntheticEnabled()) return yield* json(422, { _tag: "SyntheticAssayDisabled" })
      // A scoped question lookup makes a foreign tenant reference a 404,
      // while the composite database key remains the final authority.
      if (!(yield* (yield* QuestionRepository).getScoped(p.id!, body.questionId))) return yield* json(404, { _tag: "QuestionNotFound" })
      const group = yield* (yield* AssayRepository).enqueueGroup({ businessId: p.id!, ...body, n: body.n ?? 5 })
      return yield* json(200, { group })
    }))),
    HttpRouter.post("/api/businesses/:id/assay/facts/:factId/review", scoped((session, p) => Effect.gen(function*() {
      const body = decodeAssayRequest(ReviewAssayFactRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const ok = yield* (yield* AssayReviewRepository).reviewFact(session, p.id!, p.factId!, body.decision, body.reason)
      return yield* json(ok ? 200 : 409, { ok })
    }))),
    HttpRouter.post("/api/businesses/:id/assay/facts/:factId/retract", scoped((session, p) => Effect.gen(function*() {
      const body = decodeAssayRequest(RetractAssayFactRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const ok = yield* (yield* AssayReviewRepository).retractFact(session, p.id!, p.factId!, body.reason)
      return yield* json(ok ? 200 : 409, { ok })
    }))),
    HttpRouter.post("/api/businesses/:id/assay/findings/:findingId/review", scoped((session, p) => Effect.gen(function*() {
      const body = decodeAssayRequest(ReviewAssayFindingRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const ok = yield* (yield* AssayReviewRepository).reviewFinding(session, p.id!, p.findingId!, body.decision, body.reason)
      return yield* json(ok ? 200 : 409, { ok })
    }))),
  )
}
