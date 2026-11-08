import { Schema } from "effect"

/** Per-entity ordering, not a cross-domain clock. Snapshot payloads contain
 * persisted domain fields, not the current UI projection. */
export const RecordedHistoryEntrySchema = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.Literals(["baseline", "created", "changed"]),
  recorded_at: Schema.String,
  operation_id: Schema.optionalKey(Schema.String),
  state: Schema.Record(Schema.String, Schema.Json)
})

export const RecordedHistoryPageSchema = Schema.Struct({
  entries: Schema.Array(RecordedHistoryEntrySchema),
  through_version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  next_after_version: Schema.NullOr(Schema.Int),
  coverage: Schema.Literals(["from_creation", "from_baseline", "pending_baseline"])
})

export type RecordedHistoryPage = typeof RecordedHistoryPageSchema.Type

export const RecordedHistoryQuerySchema = Schema.Struct({
  after_version: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  through_version: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
})

export interface RecordedHistoryInput {
  readonly id: string
  readonly after_version?: number
  readonly through_version?: number
  readonly limit?: number
}

export const RecordedHistoryHttpQuerySchema = Schema.Struct({
  after_version: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  ),
  through_version: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  ),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))
  )
})
