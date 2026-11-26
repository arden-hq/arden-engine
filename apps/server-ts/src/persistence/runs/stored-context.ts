import {
  RUN_BELONGS_TO,
  RUN_ORIGIN,
  RUN_TASK_BINDING,
  type RunContext as WireRunContext,
  type RunOrigin as WireRunOrigin
} from "@arden-hq/protocol/runs"
import { NonNegativeIntSchema } from "@arden-hq/protocol/effect/common"
import { Schema } from "effect"

const Identity = Schema.NonEmptyString

const wokenAt = { chain_depth: Schema.optionalKey(NonNegativeIntSchema) }

export const RunOriginSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(RUN_ORIGIN.chat),
    session_id: Identity,
    turn_id: Identity,
    ...wokenAt
  }),
  Schema.Struct({
    kind: Schema.Literal(RUN_ORIGIN.automation),
    automation_id: Identity,
    occurrence_id: Identity,
    ...wokenAt
  }),
  Schema.Struct({
    kind: Schema.Literal(RUN_ORIGIN.task),
    item_id: Identity,
    occurrence_id: Identity,
    ...wokenAt
  }),
  Schema.Struct({
    kind: Schema.Literal(RUN_ORIGIN.space),
    space_id: Identity,
    occurrence_id: Identity,
    ...wokenAt
  }),
  Schema.Struct({ kind: Schema.Literal(RUN_ORIGIN.unrecorded) })
])

export const RunTaskBindingSchema = Schema.Struct({
  item_id: Identity,
  generation: NonNegativeIntSchema
})

export const RunContextSchema = Schema.Struct({
  origin: RunOriginSchema,
  task: Schema.NullOr(RunTaskBindingSchema),
  belongs_to: Schema.optionalKey(RunOriginSchema)
})

export type RunOrigin = typeof RunOriginSchema.Type
export type RunTaskBinding = typeof RunTaskBindingSchema.Type
export type RunContext = typeof RunContextSchema.Type

const wireRunOrigin = (origin: RunOrigin): WireRunOrigin =>
  origin.kind === RUN_ORIGIN.unrecorded
    ? origin
    : { ...origin, chain_depth: origin.chain_depth ?? 0 }

export const wireRunContext = (context: RunContext): WireRunContext => ({
  origin: wireRunOrigin(context.origin),
  task:
    context.task === null
      ? { kind: RUN_TASK_BINDING.none }
      : { kind: RUN_TASK_BINDING.task, ...context.task },
  belongs_to:
    context.belongs_to === undefined
      ? { kind: RUN_BELONGS_TO.own }
      : { kind: RUN_BELONGS_TO.carried, origin: wireRunOrigin(context.belongs_to) }
})
