import { Schema } from "effect"
import {
  IsoDateTimeStringSchema,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"

const queued = { queued_at: IsoDateTimeStringSchema }

/** Immutable admission evidence; prompt text and mutable lease state stay out. */
const DirectAutomationTriggerContextSchema = Schema.Union([
  Schema.Struct({
    ...queued,
    source: Schema.Literal("scheduled"),
    scheduled_for: IsoDateTimeStringSchema
  }),
  Schema.Struct({ ...queued, source: Schema.Literal("manual") }),
  Schema.Struct({
    ...queued,
    source: Schema.Literal("home"),
    window_id: Schema.NonEmptyString,
    fingerprint: Schema.NonEmptyString
  }),
  Schema.Struct({
    ...queued,
    source: Schema.Literal("idle"),
    input_sequence: NonNegativeIntSchema,
    input_at: IsoDateTimeStringSchema
  }),
  Schema.Struct({
    ...queued,
    source: Schema.Literal("count"),
    session_id: Schema.NonEmptyString,
    through_sequence: Schema.NullOr(NonNegativeIntSchema),
    every_n: PositiveIntSchema
  }),
  Schema.Struct({
    ...queued,
    source: Schema.Literal("event"),
    event_type: Schema.NonEmptyString,
    event_key: Schema.NonEmptyString,
    produced_by: Schema.NullOr(Schema.NonEmptyString),
    /** Automation runs behind the event; absent: 0 (`chain-depth.ts`). */
    chain_depth: Schema.optionalKey(NonNegativeIntSchema),
    context: Schema.Record(Schema.String, Schema.Json)
  }),
  Schema.Struct({ ...queued, source: Schema.Literal("wake") })
]).pipe(Schema.toTaggedUnion("source"))
export const AutomationTriggerContextSchema = Schema.Union([
  DirectAutomationTriggerContextSchema,
  Schema.Struct({
    ...queued,
    source: Schema.Literal("coalesced"),
    causes: Schema.NonEmptyArray(DirectAutomationTriggerContextSchema)
  })
]).pipe(Schema.toTaggedUnion("source"))
export type AutomationTriggerContext = typeof AutomationTriggerContextSchema.Type
