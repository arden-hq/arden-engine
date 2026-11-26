import { Schema } from "effect"
import { eventTypeLiterals } from "../common/event-types.js"
import { IsoDateTimeStringSchema, RuntimeRunStatusSchema } from "../common/schema.js"
import {
  ModelResponseResetEventSchema,
  RunStartedEventSchema,
  runTerminalEventSchemas
} from "../chat/events/run.js"
import {
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema
} from "../chat/events/tool.js"

export const RUN_PURPOSE = { none: "none", stated: "stated" } as const
export const TOOL_TITLE = { untitled: "untitled", titled: "titled" } as const

export const RunProgressSchema = Schema.Struct({
  run_id: Schema.NonEmptyString,
  session_id: Schema.NonEmptyString,
  status: RuntimeRunStatusSchema,
  started_at: IsoDateTimeStringSchema,
  through_sequence: Schema.Natural,
  trace_removed: Schema.Boolean,
  purpose: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_PURPOSE.none) }),
    Schema.Struct({ kind: Schema.Literal(RUN_PURPOSE.stated), text: Schema.String })
  ]),
  active_tools: Schema.Array(
    Schema.Struct({
      tool_call_id: Schema.NonEmptyString,
      title: Schema.Union([
        Schema.Struct({ kind: Schema.Literal(TOOL_TITLE.untitled) }),
        Schema.Struct({ kind: Schema.Literal(TOOL_TITLE.titled), title: Schema.String })
      ])
    })
  )
})
export type RunProgress = typeof RunProgressSchema.Type

export const RUN_PROGRESS_EVENT_TYPES: ReadonlySet<string> = eventTypeLiterals([
  ToolCallStartEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  ModelResponseResetEventSchema,
  RunStartedEventSchema,
  ...runTerminalEventSchemas
])
