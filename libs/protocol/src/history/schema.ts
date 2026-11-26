import { Schema } from "effect"

export const RECORDED_HISTORY_THROUGH = { head: "head", version: "version" } as const
export const RECORDED_HISTORY_NEXT = { end: "end", more: "more" } as const

export const RecordedHistoryEntrySchema = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.Literals(["baseline", "created", "changed"]),
  recorded_at: Schema.String,
  state: Schema.Record(Schema.String, Schema.Json)
})

export const RecordedHistoryPageSchema = Schema.Struct({
  entries: Schema.Array(RecordedHistoryEntrySchema),
  through_version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  next: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RECORDED_HISTORY_NEXT.end) }),
    Schema.Struct({
      kind: Schema.Literal(RECORDED_HISTORY_NEXT.more),
      after_version: Schema.Int.check(Schema.isGreaterThan(0))
    })
  ]),
  coverage: Schema.Literals(["from_creation", "from_baseline", "pending_baseline"])
})

export type RecordedHistoryPage = typeof RecordedHistoryPageSchema.Type

const queryFields = <Version extends Schema.Top, Limit extends Schema.Top>(
  version: Version,
  limit: Limit
) =>
  Schema.Union([
    Schema.Struct({
      after_version: version,
      limit,
      through: Schema.Literal(RECORDED_HISTORY_THROUGH.head)
    }),
    Schema.Struct({
      after_version: version,
      limit,
      through: Schema.Literal(RECORDED_HISTORY_THROUGH.version),
      through_version: version
    })
  ])

export const RecordedHistoryQuerySchema = queryFields(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
)

export type RecordedHistoryQuery = typeof RecordedHistoryQuerySchema.Type

export type RecordedHistoryInput = { readonly id: string } & RecordedHistoryQuery

export const RecordedHistoryHttpQuerySchema = queryFields(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))
)
