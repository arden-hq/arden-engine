import { IsoDateTimeStringSchema, RuntimeRunStatusSchema } from "@arden-hq/protocol/effect/common"
import { Schema } from "effect"
import { RunContextSchema } from "../runs/stored-context.js"
import { StoredRunQuestionSchema } from "../runs/stored-question.js"

const identity = Schema.NonEmptyString
const at = IsoDateTimeStringSchema
const source = { id: identity, at }

const HomeOfferSchema = Schema.Struct({
  offer_id: identity,
  text: Schema.String,
  why: Schema.String,
  item: Schema.NullOr(
    Schema.Struct({
      item_id: Schema.NullOr(identity),
      source: Schema.NonEmptyString,
      title: Schema.String,
      from: Schema.NullOr(Schema.String)
    })
  ),
  status: Schema.Literals(["held", "offered", "accepted", "rejected"]),
  revision: Schema.Natural,
  space_id: Schema.NullOr(identity),
  task_item_id: Schema.NullOr(identity),
  created_at: at,
  updated_at: at,
  settled_at: Schema.NullOr(at)
})

export const HomeEvidenceSchema = Schema.Union([
  Schema.Struct({
    ...source,
    kind: Schema.Literal("task"),
    event_id: Schema.NullOr(Schema.Natural),
    item_id: identity,
    history_revision: Schema.optionalKey(Schema.NullOr(identity)),
    title: Schema.String,
    event_type: identity,
    summary: Schema.String,
    status: Schema.Literals(["open", "done", "cancelled"]),
    source_refs: Schema.Array(Schema.Json),
    run_ref: Schema.NullOr(identity)
  }),
  Schema.Struct({
    ...source,
    kind: Schema.Literal("run"),
    run_id: identity,
    session_id: identity,
    context: RunContextSchema,
    status: RuntimeRunStatusSchema,
    text: Schema.String,
    error: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({ ...source, kind: Schema.Literal("question"), question: StoredRunQuestionSchema }),
  Schema.Struct({
    ...source,
    kind: Schema.Literal("approval"),
    run_id: identity,
    session_id: identity,
    tool_call_id: identity,
    tool_name: identity,
    preview: Schema.NullOr(Schema.String),
    context: Schema.NullOr(RunContextSchema)
  }),
  Schema.Struct({ ...source, kind: Schema.Literal("offer"), offer: HomeOfferSchema })
])

export const HOME_HEADLINES = ["Nothing needs you", "Since your last visit"] as const
export type HomeEvidence = typeof HomeEvidenceSchema.Type

export const HomeLetterBodySchema = Schema.Struct({
  paragraphs: Schema.Array(
    Schema.Array(
      Schema.Struct({
        text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
        source_id: Schema.NullOr(identity),
        href: Schema.optionalKey(Schema.NullOr(Schema.String))
      })
    ).check(Schema.isMinLength(1), Schema.isMaxLength(12))
  ).check(Schema.isMaxLength(2))
})
const HomeLetterSchema = Schema.Struct({
  run_id: identity,
  generated_at: at,
  window: Schema.Struct({ since: at, through: at }),
  body: HomeLetterBodySchema,
  sources: Schema.Array(HomeEvidenceSchema)
})
export const HomeLetterResponseSchema = Schema.Struct({
  generation: Schema.Literals(["idle", "pending", "running"]),
  window: Schema.Struct({ id: identity, since: at }),
  headline: Schema.Literals(HOME_HEADLINES),
  letters: Schema.Array(HomeLetterSchema),
  next_at: Schema.NullOr(at)
})
export type HomeLetterBody = typeof HomeLetterBodySchema.Type
export type HomeLetter = typeof HomeLetterSchema.Type
export type HomeLetterResponse = typeof HomeLetterResponseSchema.Type
