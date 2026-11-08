import { Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  RuntimeRunStatusSchema,
  PositiveIntSchema
} from "../common/schema.js"
import { RunContextSchema } from "./context.js"

/** A worker attempt, including historical attempts whose execution has been retained. */
export const WorkerAttemptSchema = Schema.Struct({
  id: PositiveIntSchema,
  run_id: Schema.NullOr(Schema.NonEmptyString),
  session_id: Schema.NullOr(Schema.NonEmptyString),
  context: RunContextSchema,
  status: RuntimeRunStatusSchema,
  started_at: IsoDateTimeStringSchema,
  ended_at: Schema.NullOr(IsoDateTimeStringSchema),
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String)
})

export const WorkerAttemptPageSchema = Schema.Struct({
  attempts: Schema.Array(WorkerAttemptSchema),
  next_cursor: Schema.NullOr(PositiveIntSchema)
})

export const WorkerAttemptPageOptionsSchema = Schema.Struct({
  cursor: Schema.optionalKey(PositiveIntSchema),
  limit: Schema.optionalKey(PositiveIntSchema.check(Schema.isLessThanOrEqualTo(100)))
})

/** Query of `GET /spaces/work/:itemId/attempts`. */
export const WorkerAttemptPageQuerySchema = Schema.Struct({
  cursor: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
  ),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100)
    )
  )
})

export type WorkerAttempt = typeof WorkerAttemptSchema.Type
export type WorkerAttemptPage = typeof WorkerAttemptPageSchema.Type
export type WorkerAttemptPageOptions = typeof WorkerAttemptPageOptionsSchema.Type
