import { Data, Effect, Schema } from "effect"
import { TreeFormatter } from "effect/ParseResult"

export class RowDecodeError extends Data.TaggedError("RowDecodeError")<{
  readonly table: string
  readonly detail: string
}> {}

export const UuidField = Schema.UUID
export const TextField = Schema.String
export const NullableTextField = Schema.NullOr(Schema.String)
export const IntField = Schema.Union(Schema.Number, Schema.String)
export const NullableIntField = Schema.NullOr(Schema.Union(Schema.Number, Schema.String))
export const BooleanField = Schema.Boolean
export const TimestampField = Schema.Union(Schema.instanceOf(Date), Schema.String)
export const NullableTimestampField = Schema.NullOr(Schema.Union(Schema.instanceOf(Date), Schema.String))
export const NullableUuidField = Schema.NullOr(Schema.UUID)
export const JsonValueField = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.Unknown),
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
)
export const NullableJsonField = Schema.NullOr(JsonValueField)

export const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v))

export const decodeRow = <A, I>(schema: Schema.Schema<A, I>, table: string, row: unknown): Effect.Effect<A, RowDecodeError> => {
  const result = Schema.decodeUnknownEither(schema)(row)
  if (result._tag === "Right") return Effect.succeed(result.right)
  let detail: string
  try {
    detail = TreeFormatter.formatErrorSync(result.left).slice(0, 500)
  } catch {
    try {
      detail = JSON.stringify(result.left).slice(0, 500)
    } catch {
      detail = String(result.left).slice(0, 500)
    }
  }
  return Effect.fail(new RowDecodeError({ table, detail }))
}
