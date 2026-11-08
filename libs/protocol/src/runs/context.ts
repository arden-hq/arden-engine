import { Schema } from "effect"
import { NonNegativeIntSchema } from "../common/schema.js"

const Identity = Schema.NonEmptyString

/** Captured once at admission. Later delivery destinations do
 * not rewrite the request that caused this attempt. */
export const RunOriginSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chat"), session_id: Identity, turn_id: Identity }),
  Schema.Struct({
    kind: Schema.Literal("automation"),
    automation_id: Identity,
    occurrence_id: Identity,
    /** Automation runs behind the wake that started this one; absent: 0. */
    chain_depth: Schema.optionalKey(NonNegativeIntSchema)
  }),
  Schema.Struct({ kind: Schema.Literal("task"), item_id: Identity, occurrence_id: Identity }),
  Schema.Struct({ kind: Schema.Literal("space"), space_id: Identity, occurrence_id: Identity }),
  Schema.Struct({ kind: Schema.Literal("unrecorded") })
])

export const RunTaskBindingSchema = Schema.Struct({
  item_id: Identity,
  generation: NonNegativeIntSchema
})

export const RunContextSchema = Schema.Struct({
  origin: RunOriginSchema,
  task: Schema.NullOr(RunTaskBindingSchema),
  /** The work a run in a chat nobody watches belongs to: the origin of the
   *  run that caused it (an answered question, a helper agent, a result),
   *  carried down a chain. Its asks and results show there; `origin` still
   *  decides who may act. Absent: the run shows where its origin says. */
  belongs_to: Schema.optionalKey(RunOriginSchema)
})

/** The work a run belongs to when it is a Task or an Automation: what names
 *  who asks on a card shown in another chat. */
export const RunApprovalWorkSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("task"), item_id: Identity }),
  Schema.Struct({ kind: Schema.Literal("automation"), automation_id: Identity })
])

export type RunOrigin = typeof RunOriginSchema.Type
export type RunApprovalWork = typeof RunApprovalWorkSchema.Type
export type RunTaskBinding = typeof RunTaskBindingSchema.Type
export type RunContext = typeof RunContextSchema.Type
