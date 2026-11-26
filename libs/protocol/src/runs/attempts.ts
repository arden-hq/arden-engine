import { Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  RuntimeRunStatusSchema,
  PositiveIntSchema
} from "../common/schema.js"
import { RunContextSchema } from "./context.js"
import { RunAttemptPageNextSchema } from "./list-options.js"

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
  next: RunAttemptPageNextSchema
})

export type WorkerAttempt = typeof WorkerAttemptSchema.Type
export type WorkerAttemptPage = typeof WorkerAttemptPageSchema.Type
