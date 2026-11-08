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

/** Compact activity at one durable journal position; no transcript or tool output. */
export const RunProgressSchema = Schema.Struct({
  run_id: Schema.NonEmptyString,
  session_id: Schema.NonEmptyString,
  status: RuntimeRunStatusSchema,
  started_at: IsoDateTimeStringSchema,
  through_sequence: Schema.Natural,
  trace_removed: Schema.Boolean,
  purpose: Schema.optionalKey(Schema.NullOr(Schema.String)),
  active_tools: Schema.Array(
    Schema.Struct({
      tool_call_id: Schema.NonEmptyString,
      title: Schema.NullOr(Schema.String)
    })
  )
})
export type RunProgress = typeof RunProgressSchema.Type

/**
 * Events after which a cached `RunProgress` for their Session is stale: a Run
 * started or ended, or its active tools changed. Every terminal event is a
 * member (finished, failed, cancelled): the server's run record is the truth,
 * so a failed Run must not keep showing the progress it had before it failed.
 */
export const RUN_PROGRESS_EVENT_TYPES: ReadonlySet<string> = eventTypeLiterals([
  ToolCallStartEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  ModelResponseResetEventSchema,
  RunStartedEventSchema,
  ...runTerminalEventSchemas
])
