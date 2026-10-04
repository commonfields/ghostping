import { Context, Effect, Layer } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlError } from "@effect/sql/SqlError"
import { createHash } from "node:crypto"
import { RawDigestMismatch } from "./repositories.js"
export interface ProviderAttemptEvidenceInput {
  readonly checkRunId: string
  readonly businessId: string
  readonly attempt: number
  readonly failureClass: string
  readonly status: number | null
  readonly bytes: Uint8Array
  readonly digest: string
  readonly contentType: string | null
  readonly responseMaxBytes: number
}
export class ProviderAttemptEvidenceRepository extends Context.Tag("ProviderAttemptEvidenceRepository")<
  ProviderAttemptEvidenceRepository,
  { readonly record: (input: ProviderAttemptEvidenceInput) => Effect.Effect<void, SqlError | RawDigestMismatch> }
>() {}
export const ProviderAttemptEvidenceRepositoryLive = Layer.effect(ProviderAttemptEvidenceRepository, Effect.gen(function*() {
  const sql = yield* PgClient.PgClient
  return { record: (i) => Effect.gen(function*() {
    if (createHash("sha256").update(i.bytes).digest("hex") !== i.digest) return yield* Effect.fail(new RawDigestMismatch({ digest: i.digest }))
    const rows = yield* sql`INSERT INTO provider_attempt_evidence
      (check_run_id, business_id, attempt, failure_class, status, digest, raw_bytes_hex, content_type, response_max_bytes)
      SELECT id, business_id, ${i.attempt}, ${i.failureClass}, ${i.status}, ${i.digest}, ${Buffer.from(i.bytes).toString("hex")}, ${i.contentType}, ${i.responseMaxBytes}
      FROM check_runs WHERE id = ${i.checkRunId} AND business_id = ${i.businessId} AND status = 'RUNNING'
      RETURNING check_run_id`
    if (rows.length !== 1) return yield* Effect.fail(new SqlError({ message: "provider evidence rejected: scoped RUNNING ownership required" }))
  }) }
}))
