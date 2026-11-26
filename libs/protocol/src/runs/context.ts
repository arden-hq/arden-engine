import { Schema } from "effect"
import { NonNegativeIntSchema } from "../common/schema.js"

const Identity = Schema.NonEmptyString

const wokenAt = { chain_depth: NonNegativeIntSchema }

export const RUN_ORIGIN = {
  chat: "chat",
  automation: "automation",
  task: "task",
  space: "space",
  unrecorded: "unrecorded"
} as const

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

export const RUN_TASK_BINDING = { none: "none", task: "task" } as const

export const RunTaskBindingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RUN_TASK_BINDING.none) }),
  Schema.Struct({
    kind: Schema.Literal(RUN_TASK_BINDING.task),
    item_id: Identity,
    generation: NonNegativeIntSchema
  })
])

export const RUN_BELONGS_TO = { own: "own", carried: "carried" } as const

export const RunContextSchema = Schema.Struct({
  origin: RunOriginSchema,
  task: RunTaskBindingSchema,
  belongs_to: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUN_BELONGS_TO.own) }),
    Schema.Struct({ kind: Schema.Literal(RUN_BELONGS_TO.carried), origin: RunOriginSchema })
  ])
})

export const RUN_APPROVAL_WORK = { task: "task", automation: "automation" } as const

export const RunApprovalWorkSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(RUN_APPROVAL_WORK.task), item_id: Identity }),
  Schema.Struct({ kind: Schema.Literal(RUN_APPROVAL_WORK.automation), automation_id: Identity })
])

export type RunOrigin = typeof RunOriginSchema.Type
export type RunApprovalWork = typeof RunApprovalWorkSchema.Type
export type RunTaskBinding = typeof RunTaskBindingSchema.Type
export type RunContext = typeof RunContextSchema.Type
