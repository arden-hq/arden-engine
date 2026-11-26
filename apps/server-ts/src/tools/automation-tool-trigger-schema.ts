import { AUTOMATION_EVENT_TYPE } from "@arden-hq/protocol/automations"
import { TriggerIdSchema } from "@arden-hq/protocol/effect/automations"
import { NonNegativeIntSchema, PositiveIntSchema } from "@arden-hq/protocol/effect/common"
import { Schema } from "effect"

const TrimmedTextSchema = Schema.Trim.check(Schema.isMinLength(1))
const OptionalTextSchema = Schema.optionalKey(TrimmedTextSchema)
const RunOnlyIfSchema = TrimmedTextSchema.check(Schema.isMaxLength(300))
const triggerId = Schema.optionalKey(TriggerIdSchema)

const timeTriggerCheck = Schema.makeFilter(
  (trigger: {
    readonly at?: string
    readonly on?: string
    readonly days?: string
    readonly every?: string
    readonly start?: string
    readonly end?: string
  }) => {
    if ((trigger.at === undefined) === (trigger.every === undefined)) {
      return { path: [], issue: "requires exactly one of at or every" }
    }
    if (trigger.on !== undefined && trigger.at === undefined) {
      return { path: ["on"], issue: "requires at" }
    }
    if (trigger.on !== undefined && trigger.days !== undefined) {
      return { path: ["on"], issue: "cannot be combined with days" }
    }
    if ((trigger.start !== undefined || trigger.end !== undefined) && trigger.every === undefined) {
      return { path: [], issue: "start and end require an interval trigger" }
    }
    return undefined
  }
)

export const ToolTimeTriggerSchema = Schema.Struct({
  id: triggerId,
  type: Schema.Literal("time"),
  at: OptionalTextSchema,
  on: OptionalTextSchema,
  days: OptionalTextSchema,
  every: OptionalTextSchema,
  start: OptionalTextSchema,
  end: OptionalTextSchema
}).check(timeTriggerCheck)

const McpEventSelectorSchema = Schema.Struct({
  server: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  event: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
})

export const ToolEventTriggerSchema = Schema.Struct({
  id: triggerId,
  type: Schema.Literal("event"),
  event_type: Schema.Literals(Object.values(AUTOMATION_EVENT_TYPE)),
  lead_minutes: Schema.optionalKey(Schema.NullOr(NonNegativeIntSchema)),
  mcp_event: Schema.optionalKey(Schema.NullOr(McpEventSelectorSchema)),
  condition: Schema.optionalKey(Schema.Null),
  run_only_if: Schema.optionalKey(Schema.NullOr(RunOnlyIfSchema))
})

export const ToolIdleTriggerSchema = Schema.Struct({
  id: triggerId,
  type: Schema.Literal("idle"),
  idle_minutes: PositiveIntSchema
})

export const ToolCountTriggerSchema = Schema.Struct({
  id: triggerId,
  type: Schema.Literal("count"),
  every_n: PositiveIntSchema
})

export type ToolTrigger =
  | (typeof ToolTimeTriggerSchema)["Type"]
  | (typeof ToolEventTriggerSchema)["Type"]
  | (typeof ToolIdleTriggerSchema)["Type"]
  | (typeof ToolCountTriggerSchema)["Type"]
