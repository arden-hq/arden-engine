import { Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"

const queued = { queued_at: IsoDateTimeStringSchema }

export const AUTOMATION_OCCURRENCE = {
  scheduled: "scheduled",
  manual: "manual",
  home: "home",
  idle: "idle",
  count: "count",
  event: "event",
  wake: "wake",
  coalesced: "coalesced"
} as const
export type AutomationOccurrence =
  (typeof AUTOMATION_OCCURRENCE)[keyof typeof AUTOMATION_OCCURRENCE]

export const AutomationEventProducerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("outside") }),
  Schema.Struct({ kind: Schema.Literal("automation"), automation_id: Schema.NonEmptyString })
]).pipe(Schema.toTaggedUnion("kind"))
export type AutomationEventProducer = typeof AutomationEventProducerSchema.Type

export const AutomationCountThroughSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unrecorded") }),
  Schema.Struct({ kind: Schema.Literal("message"), sequence: NonNegativeIntSchema })
]).pipe(Schema.toTaggedUnion("kind"))
export type AutomationCountThrough = typeof AutomationCountThroughSchema.Type

export const AUTOMATION_TRIGGER_SOURCE = {
  scheduled: "scheduled",
  manual: "manual",
  home: "home",
  idle: "idle",
  count: "count",
  event: "event",
  wake: "wake",
  coalesced: "coalesced"
} as const

export type AutomationTriggerSource =
  (typeof AUTOMATION_TRIGGER_SOURCE)[keyof typeof AUTOMATION_TRIGGER_SOURCE]

const DirectAutomationTriggerContextSchema = Schema.Union([
  Schema.Struct({
    ...queued,
    source: Schema.Literal(AUTOMATION_OCCURRENCE.scheduled),
    scheduled_for: IsoDateTimeStringSchema
  }),
  Schema.Struct({ ...queued, source: Schema.Literal(AUTOMATION_OCCURRENCE.manual) }),
  Schema.Struct({
    ...queued,
    source: Schema.Literal(AUTOMATION_OCCURRENCE.home),
    window_id: Schema.NonEmptyString,
    fingerprint: Schema.NonEmptyString
  }),
  Schema.Struct({
    ...queued,
    source: Schema.Literal(AUTOMATION_OCCURRENCE.idle),
    input_sequence: NonNegativeIntSchema,
    input_at: IsoDateTimeStringSchema
  }),
  Schema.Struct({
    ...queued,
    source: Schema.Literal(AUTOMATION_OCCURRENCE.count),
    session_id: Schema.NonEmptyString,
    through: AutomationCountThroughSchema,
    every_n: PositiveIntSchema
  }),
  Schema.Struct({
    ...queued,
    source: Schema.Literal(AUTOMATION_OCCURRENCE.event),
    event_type: Schema.NonEmptyString,
    event_key: Schema.NonEmptyString,
    produced_by: AutomationEventProducerSchema,
    chain_depth: NonNegativeIntSchema,
    context: Schema.Record(Schema.String, Schema.Json)
  }),
  Schema.Struct({ ...queued, source: Schema.Literal(AUTOMATION_OCCURRENCE.wake) })
]).pipe(Schema.toTaggedUnion("source"))
export const AutomationTriggerContextSchema = Schema.Union([
  DirectAutomationTriggerContextSchema,
  Schema.Struct({
    ...queued,
    source: Schema.Literal(AUTOMATION_OCCURRENCE.coalesced),
    causes: Schema.NonEmptyArray(DirectAutomationTriggerContextSchema)
  })
]).pipe(Schema.toTaggedUnion("source"))
export type AutomationTriggerContext = typeof AutomationTriggerContextSchema.Type
