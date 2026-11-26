import { Schema } from "effect"
import type { Agrees, Assert } from "../common/type-agreement.js"
import type { JsonRecord } from "../common/json.js"
import { withExtras } from "../common/schema.js"
import {
  GmailSendSchema,
  ToolDataSchema,
  ToolFaceFields,
  ToolRetrySchema,
  type GmailSend,
  type ToolData,
  type ToolFace,
  type ToolRetry
} from "./tool-face.js"

export const TOOL_CALL_STARTED = { unrecorded: "unrecorded", at: "at" } as const
export type ToolCallStarted =
  | { readonly kind: typeof TOOL_CALL_STARTED.unrecorded }
  | { readonly kind: typeof TOOL_CALL_STARTED.at; readonly at: number }

export const TOOL_CALL_RESULT = { unshown: "unshown", shown: "shown" } as const
export type ToolCallResult =
  | { readonly kind: typeof TOOL_CALL_RESULT.unshown }
  | { readonly kind: typeof TOOL_CALL_RESULT.shown; readonly text: string }

export const TOOL_DURATION = { untimed: "untimed", timed: "timed" } as const
export type ToolDuration =
  | { readonly kind: typeof TOOL_DURATION.untimed }
  | { readonly kind: typeof TOOL_DURATION.timed; readonly ms: number }

export const TOOL_CALL_STATUS = { open: "open", settled: "settled" } as const
export type ToolCallStatus =
  | { readonly kind: typeof TOOL_CALL_STATUS.open }
  | {
      readonly kind: typeof TOOL_CALL_STATUS.settled
      readonly is_error: boolean
      readonly retry: ToolRetry
      readonly duration: ToolDuration
    }

export interface HistoryToolCall extends ToolFace, JsonRecord {
  readonly id: string
  readonly name: string
  readonly arguments: string
  readonly started: ToolCallStarted
  readonly result: ToolCallResult
  readonly status: ToolCallStatus
  readonly gmail_send: GmailSend
  readonly data: ToolData
}

const tagged = <const Tag extends string>(kind: Tag) =>
  Schema.Struct({ kind: Schema.Literal(kind) })

export const ToolCallStatusSchema = Schema.Union([
  tagged(TOOL_CALL_STATUS.open),
  Schema.Struct({
    kind: Schema.Literal(TOOL_CALL_STATUS.settled),
    is_error: Schema.Boolean,
    retry: ToolRetrySchema,
    duration: Schema.Union([
      tagged(TOOL_DURATION.untimed),
      Schema.Struct({ kind: Schema.Literal(TOOL_DURATION.timed), ms: Schema.Number })
    ])
  })
])

export const HistoryToolCallSchema = withExtras({
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  ...ToolFaceFields,
  started: Schema.Union([
    tagged(TOOL_CALL_STARTED.unrecorded),
    Schema.Struct({ kind: Schema.Literal(TOOL_CALL_STARTED.at), at: Schema.Number })
  ]),
  result: Schema.Union([
    tagged(TOOL_CALL_RESULT.unshown),
    Schema.Struct({ kind: Schema.Literal(TOOL_CALL_RESULT.shown), text: Schema.String })
  ]),
  status: ToolCallStatusSchema,
  gmail_send: GmailSendSchema,
  data: ToolDataSchema
})

export type HistoryToolCallAgrees = Assert<
  Agrees<typeof HistoryToolCallSchema.Type, HistoryToolCall>
>
