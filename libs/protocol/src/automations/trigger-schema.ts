import { Schema } from "effect"
import { withExtras, NonNegativeIntSchema, PositiveIntSchema } from "../common/schema.js"
import {
  AUTOMATION_CONDITION,
  CONDITION_OPERATOR,
  type AutomationCondition,
  type AutomationValueOperator
} from "./contracts.js"
import {
  APP_EVENT,
  LEAD_EVENT,
  type AutomationTrigger,
  type AutomationTriggerEdit,
  type AutomationTriggerInput,
  type AutomationTriggerSpec,
  type PlainEventType
} from "./trigger-contracts.js"
import { AUTOMATION_EVENT_TYPE } from "./triggers.js"

const TrimmedTextSchema = Schema.Trim.check(Schema.isMinLength(1))
const RunOnlyIfTextSchema = TrimmedTextSchema.check(Schema.isMaxLength(300))
export const TriggerIdSchema = Schema.String.check(Schema.isPattern(/^t[1-9]\d*$/u))

type StructOf = typeof Schema.Struct | typeof withExtras

const AutomationValueOperatorSchema = Schema.Literals(
  Object.values(CONDITION_OPERATOR).filter(
    (operator): operator is AutomationValueOperator =>
      operator !== CONDITION_OPERATOR.in && operator !== CONDITION_OPERATOR.exists
  )
)

export const AutomationConditionOperatorSchema = Schema.Literals(Object.values(CONDITION_OPERATOR))

const conditionSchema = (
  struct: StructOf,
  self: () => Schema.Codec<AutomationCondition>
): Schema.Codec<AutomationCondition> =>
  Schema.Union([
    struct({
      kind: Schema.Literal(AUTOMATION_CONDITION.compare),
      field: TrimmedTextSchema,
      op: AutomationValueOperatorSchema,
      value: Schema.Json
    }),
    struct({
      kind: Schema.Literal(AUTOMATION_CONDITION.compare),
      field: TrimmedTextSchema,
      op: Schema.Literal(CONDITION_OPERATOR.in),
      value: Schema.Array(Schema.Json)
    }),
    struct({
      kind: Schema.Literal(AUTOMATION_CONDITION.compare),
      field: TrimmedTextSchema,
      op: Schema.Literal(CONDITION_OPERATOR.exists)
    }),
    struct({
      kind: Schema.Literal(AUTOMATION_CONDITION.and),
      conditions: Schema.NonEmptyArray(Schema.suspend(self))
    }),
    struct({
      kind: Schema.Literal(AUTOMATION_CONDITION.or),
      conditions: Schema.NonEmptyArray(Schema.suspend(self))
    }),
    struct({ kind: Schema.Literal(AUTOMATION_CONDITION.not), condition: Schema.suspend(self) })
  ])

export const AutomationConditionInputSchema: Schema.Codec<AutomationCondition> = conditionSchema(
  Schema.Struct,
  () => AutomationConditionInputSchema
)

export const AutomationConditionSchema: Schema.Codec<AutomationCondition> = conditionSchema(
  withExtras,
  () => AutomationConditionSchema
)

const kind = <const Kind extends string>(value: Kind) => ({ kind: Schema.Literal(value) })

const TriggerDaysSchema = Schema.Union([
  Schema.Struct(kind("every_day")),
  Schema.Struct({ ...kind("days"), days: TrimmedTextSchema })
])

const IntervalWindowSchema = Schema.Union([
  Schema.Struct(kind("all_day")),
  Schema.Struct({ ...kind("from"), start: TrimmedTextSchema }),
  Schema.Struct({ ...kind("until"), end: TrimmedTextSchema }),
  Schema.Struct({ ...kind("between"), start: TrimmedTextSchema, end: TrimmedTextSchema })
])

export const TimeTriggerScheduleSchema = Schema.Union([
  Schema.Struct({ ...kind("next"), at: TrimmedTextSchema }),
  Schema.Struct({ ...kind("once"), at: TrimmedTextSchema, on: TrimmedTextSchema }),
  Schema.Struct({ ...kind("daily"), at: TrimmedTextSchema, days: TrimmedTextSchema }),
  Schema.Struct({
    ...kind("interval"),
    every: TrimmedTextSchema,
    days: TriggerDaysSchema,
    window: IntervalWindowSchema
  })
])

const EventLeadSchema = Schema.Union([
  Schema.Struct(kind("default")),
  Schema.Struct({ ...kind("minutes"), minutes: NonNegativeIntSchema })
])

const RunOnlyIfSchema = Schema.Union([
  Schema.Struct(kind("any_event")),
  Schema.Struct({ ...kind("sentence"), sentence: RunOnlyIfTextSchema })
])

const oldConditionSchema = (condition: Schema.Codec<AutomationCondition>) =>
  Schema.Union([Schema.Struct(kind("none")), Schema.Struct({ ...kind("old"), condition })])

const KeptSchema = Schema.Struct(kind("kept"))

const mcpEventSelectorFields = {
  server: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  event: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  arguments: Schema.Record(Schema.String, Schema.Json)
} as const

const McpEventSelectorSchema = Schema.Struct(mcpEventSelectorFields)
const McpEventChoiceSchema = Schema.Union([
  KeptSchema,
  Schema.Struct({ ...kind("chosen"), ...mcpEventSelectorFields })
])

const PLAIN_EVENT_TYPES = Object.values(AUTOMATION_EVENT_TYPE).filter(
  (type): type is PlainEventType => type !== LEAD_EVENT && type !== APP_EVENT
)

const triggerVariants = <
  const Id extends Schema.Struct.Fields,
  Filters extends Schema.Struct.Fields,
  Lead extends Schema.Top,
  App extends Schema.Top
>(
  struct: StructOf,
  id: Id,
  event: { readonly filters: Filters; readonly lead: Lead; readonly app: App }
) =>
  [
    struct({ ...id, type: Schema.Literal("time"), schedule: TimeTriggerScheduleSchema }),
    struct({
      ...id,
      type: Schema.Literal("event"),
      event_type: Schema.Literal(LEAD_EVENT),
      lead: event.lead,
      ...event.filters
    }),
    struct({
      ...id,
      type: Schema.Literal("event"),
      event_type: Schema.Literal(APP_EVENT),
      mcp_event: event.app,
      ...event.filters
    }),
    struct({
      ...id,
      type: Schema.Literal("event"),
      event_type: Schema.Literals(PLAIN_EVENT_TYPES),
      ...event.filters
    }),
    struct({ ...id, type: Schema.Literal("idle"), idle_minutes: PositiveIntSchema }),
    struct({ ...id, type: Schema.Literal("count"), every_n: PositiveIntSchema })
  ] as const

const specEvent = (condition: Schema.Codec<AutomationCondition>) => ({
  filters: { run_only_if: RunOnlyIfSchema, condition: oldConditionSchema(condition) },
  lead: EventLeadSchema,
  app: McpEventSelectorSchema
})

export const AutomationTriggerSchema: Schema.Codec<AutomationTrigger> = Schema.Union(
  triggerVariants(withExtras, { id: TriggerIdSchema }, specEvent(AutomationConditionSchema))
)

export const AutomationTriggerSpecSchema: Schema.Codec<AutomationTriggerSpec> = Schema.Union(
  triggerVariants(withExtras, {}, specEvent(AutomationConditionSchema))
)

export const AutomationTriggerSpecInputSchema: Schema.Codec<AutomationTriggerSpec> = Schema.Union(
  triggerVariants(Schema.Struct, {}, specEvent(AutomationConditionInputSchema))
)

const AutomationTriggerEditInputSchema: Schema.Codec<AutomationTriggerEdit> = Schema.Union(
  triggerVariants(
    Schema.Struct,
    {},
    {
      filters: {
        run_only_if: Schema.Union([RunOnlyIfSchema, KeptSchema]),
        condition: Schema.Union([oldConditionSchema(AutomationConditionInputSchema), KeptSchema])
      },
      lead: Schema.Union([EventLeadSchema, KeptSchema]),
      app: McpEventChoiceSchema
    }
  )
)

export const AutomationTriggerInputSchema: Schema.Codec<AutomationTriggerInput> = Schema.Union([
  Schema.Struct({ ...kind("new"), trigger: AutomationTriggerSpecInputSchema }),
  Schema.Struct({
    ...kind("edit"),
    id: TriggerIdSchema,
    trigger: AutomationTriggerEditInputSchema
  })
])
