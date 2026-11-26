import { Schema } from "effect"
import {
  AUTOMATION_CONTEXT_MODE,
  AUTOMATION_RUN_SKIP_REASON,
  type AutomationRunsResponse
} from "./contracts.js"
import { IsoDateTimeStringSchema, PositiveIntSchema, withExtras } from "../common/schema.js"
import { AUTOMATION_EVENT_TYPE } from "./triggers.js"

const AutomationEventTypeSchema = Schema.Literals(Object.values(AUTOMATION_EVENT_TYPE))

const QueryLimitSchema = Schema.Union([Schema.Number, Schema.NumberFromString]).check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 200 })
)

export const AutomationRunsQuerySchema = withExtras({
  limit: QueryLimitSchema
})

export const AutomationEventLinkSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("chat"),
    session_id: Schema.NonEmptyString,
    session_ref: Schema.NonEmptyString
  }),
  Schema.Struct({ kind: Schema.Literal("memory_page"), path: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("task"), item_id: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("connection_item"), item_id: Schema.NonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("connection_item_with_page"),
    item_id: Schema.NonEmptyString,
    url: Schema.NonEmptyString
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationSkippedEventSchema = Schema.Struct({
  event_type: AutomationEventTypeSchema,
  title: Schema.NonEmptyString,
  link: AutomationEventLinkSchema
})

export const AutomationSkipRunWithEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not_asked") }),
  Schema.Struct({ kind: Schema.Literal("queued"), at: IsoDateTimeStringSchema }),
  Schema.Struct({
    kind: Schema.Literal("started"),
    at: IsoDateTimeStringSchema,
    run_id: PositiveIntSchema
  }),
  Schema.Struct({ kind: Schema.Literal("cancelled"), at: IsoDateTimeStringSchema })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationRunSkipSchema = Schema.Struct({
  reason: Schema.Literal(AUTOMATION_RUN_SKIP_REASON.prefilter),
  backend: Schema.NonEmptyString,
  event: AutomationSkippedEventSchema,
  asked: Schema.Array(Schema.NonEmptyString),
  run_with_event: AutomationSkipRunWithEventSchema
})

export const AutomationRunChatSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("chat"), session_id: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("chat_run"),
    session_id: Schema.String,
    run_id: Schema.String
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationRunOutputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("result"), result: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("error"), error: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("result_and_error"),
    result: Schema.String,
    error: Schema.String
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const AutomationContextModeSchema = Schema.Literals(Object.values(AUTOMATION_CONTEXT_MODE))

const automationRunFields = {
  id: PositiveIntSchema,
  task_id: Schema.NonEmptyString,
  context_mode: AutomationContextModeSchema,
  started_at: IsoDateTimeStringSchema
} as const

const endedAutomationRun = <
  const Status extends "completed" | "blocked" | "failed" | "cancelled" | "interrupted"
>(
  status: Status
) =>
  withExtras({
    ...automationRunFields,
    status: Schema.Literal(status),
    ended_at: IsoDateTimeStringSchema,
    chat: AutomationRunChatSchema,
    output: AutomationRunOutputSchema
  })

export const AutomationRunSchema = Schema.Union([
  withExtras({
    ...automationRunFields,
    status: Schema.Literal("running"),
    chat: AutomationRunChatSchema,
    output: AutomationRunOutputSchema
  }),
  endedAutomationRun("completed"),
  endedAutomationRun("blocked"),
  endedAutomationRun("failed"),
  endedAutomationRun("cancelled"),
  endedAutomationRun("interrupted"),
  withExtras({
    ...automationRunFields,
    status: Schema.Literal("skipped"),
    ended_at: IsoDateTimeStringSchema,
    result: Schema.String,
    skip: AutomationRunSkipSchema
  })
]).pipe(Schema.toTaggedUnion("status"))

export const AutomationRunsResponseSchema: Schema.Codec<AutomationRunsResponse> = withExtras({
  runs: Schema.Array(AutomationRunSchema)
})
