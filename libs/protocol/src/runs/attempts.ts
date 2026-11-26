import { Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  RuntimeRunStatusSchema,
  PositiveIntSchema
} from "../common/schema.js"
import { RunContextSchema } from "./context.js"
import { RunAttemptPageNextSchema } from "./list-options.js"

export const ATTEMPT_RUN = { none: "none", run: "run" } as const
export const ATTEMPT_END = { open: "open", ended: "ended" } as const
export const ATTEMPT_TEXT = { none: "none", text: "text" } as const

export const WorkerAttemptSchema = Schema.Struct({
  id: PositiveIntSchema,
  run: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(ATTEMPT_RUN.none) }),
    Schema.Struct({
      kind: Schema.Literal(ATTEMPT_RUN.run),
      run_id: Schema.NonEmptyString,
      session_id: Schema.NonEmptyString
    })
  ]),
  context: RunContextSchema,
  status: RuntimeRunStatusSchema,
  started_at: IsoDateTimeStringSchema,
  end: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(ATTEMPT_END.open) }),
    Schema.Struct({ kind: Schema.Literal(ATTEMPT_END.ended), at: IsoDateTimeStringSchema })
  ]),
  result: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(ATTEMPT_TEXT.none) }),
    Schema.Struct({ kind: Schema.Literal(ATTEMPT_TEXT.text), text: Schema.String })
  ]),
  error: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(ATTEMPT_TEXT.none) }),
    Schema.Struct({ kind: Schema.Literal(ATTEMPT_TEXT.text), text: Schema.String })
  ])
})

export const WorkerAttemptPageSchema = Schema.Struct({
  attempts: Schema.Array(WorkerAttemptSchema),
  next: RunAttemptPageNextSchema
})

export type WorkerAttempt = typeof WorkerAttemptSchema.Type
export type WorkerAttemptPage = typeof WorkerAttemptPageSchema.Type
