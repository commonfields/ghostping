// Auth repository over PostgreSQL (@effect/sql-pg).
// Effect owns all Postgres access; no pg.Pool here.
import { randomUUID } from "node:crypto"
import { Context, Data, Effect, Layer } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import type { DbEffect } from "./repositories.js"

export interface Session {
  readonly userId: string
  readonly accountId: string
}

export class EmailTaken extends Data.TaggedError("EmailTaken")<Record<string, never>> {}

const isUniqueViolation = (e: unknown): boolean => {
  if (e !== null && typeof e === "object" && "cause" in e) {
    const cause = (e as { cause?: unknown }).cause
    if (cause !== null && typeof cause === "object" && "code" in cause) {
      return (cause as { code?: unknown }).code === "23505"
    }
  }
  return false
}

export class AuthRepository extends Context.Tag("AuthRepository")<
  AuthRepository,
  {
    readonly getSession: (sessionId: string) => DbEffect<Session | null>
    readonly signup: (input: {
      email: string
      passwordHash: string
      accountName: string
    }) => Effect.Effect<{ accountId: string; userId: string; sessionId: string }, SqlError | EmailTaken>
    readonly signinLookup: (email: string) => DbEffect<{ id: string; passwordHash: string; accountId: string } | null>
    readonly createSession: (input: { userId: string; accountId: string }) => DbEffect<string>
    readonly deleteSession: (sessionId: string) => DbEffect<void>
  }
>() {}

export const AuthRepositoryLive = Layer.effect(
  AuthRepository,
  Effect.map(PgClient.PgClient, (sql: SqlClient.SqlClient) => ({
    getSession: (sessionId: string) =>
      sql`SELECT user_id, account_id FROM sessions WHERE id = ${sessionId} AND expires_at > now()`.pipe(
        Effect.map((rows) => {
          const r = (rows as Array<Record<string, unknown>>)[0]
          if (!r) return null
          return { userId: String(r["user_id"]), accountId: String(r["account_id"]) }
        }),
      ),
    signup: (input: { email: string; passwordHash: string; accountName: string }) =>
      sql
        .withTransaction(
          Effect.gen(function*() {
            const existing = (yield* sql`SELECT id FROM users WHERE lower(email::text) = lower(${input.email}) LIMIT 1`) as Array<
              Record<string, unknown>
            >
            if (existing[0]) return yield* Effect.fail(new EmailTaken({}))
            const aRows = (yield* sql`INSERT INTO accounts (name) VALUES (${input.accountName}) RETURNING id`) as Array<
              Record<string, unknown>
            >
            const accountId = String((aRows[0] as Record<string, unknown>)["id"])
            const uRows = (yield* sql`INSERT INTO users (email, password_hash) VALUES (${input.email}, ${input.passwordHash}) RETURNING id`) as Array<
              Record<string, unknown>
            >
            const userId = String((uRows[0] as Record<string, unknown>)["id"])
            yield* sql`INSERT INTO account_users (account_id, user_id) VALUES (${accountId}, ${userId})`
            const sessionId = randomUUID()
            yield* sql`INSERT INTO sessions (id, user_id, account_id, expires_at) VALUES (${sessionId}, ${userId}, ${accountId}, now() + interval '30 days')`
            return { accountId, userId, sessionId }
          }),
        )
        .pipe(
          Effect.catchAll(
            (e): Effect.Effect<never, SqlError | EmailTaken> => {
              if (e instanceof EmailTaken) return Effect.fail(e)
              if (isUniqueViolation(e)) return Effect.fail(new EmailTaken({}))
              return Effect.fail(e as SqlError)
            },
          ),
        ),
    signinLookup: (email: string) =>
      Effect.gen(function*() {
        const rows = (yield* sql`SELECT u.id, u.password_hash, au.account_id FROM users u JOIN account_users au ON au.user_id = u.id WHERE lower(u.email::text) = lower(${email}) LIMIT 1`) as Array<
          Record<string, unknown>
        >
        const r = rows[0]
        if (!r) return null
        return { id: String(r["id"]), passwordHash: String(r["password_hash"]), accountId: String(r["account_id"]) }
      }),
    createSession: (input: { userId: string; accountId: string }) =>
      Effect.gen(function*() {
        const sessionId = randomUUID()
        yield* sql`INSERT INTO sessions (id, user_id, account_id, expires_at) VALUES (${sessionId}, ${input.userId}, ${input.accountId}, now() + interval '30 days')`
        return sessionId
      }),
    deleteSession: (sessionId: string) =>
      sql`DELETE FROM sessions WHERE id = ${sessionId}`.pipe(Effect.asVoid),
  })),
)
