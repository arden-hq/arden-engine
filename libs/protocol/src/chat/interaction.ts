import { Schema } from "effect"
import { optionalString } from "../common/schema.js"

export const InteractionActorSchema = Schema.Struct({
  type: Schema.Literals(["agent", "workflow", "tool", "harness", "user"] as const),
  id: Schema.NonEmptyString,
  display_name: optionalString
})

export const InteractionReferenceSchema = Schema.Struct({
  type: Schema.Literals(["message", "run", "tool_call", "workflow"] as const),
  id: Schema.NonEmptyString
})

const interactionParties = {
  from: InteractionActorSchema,
  to: InteractionActorSchema,
  content: Schema.String,
  /** One plain line for the row when `content` is written for the recipient. */
  preview: optionalString,
  causedBy: Schema.optionalKey(InteractionReferenceSchema)
}

/** Mirrors `Interaction` in libs/loop: the stored provenance of a delivered
 *  message. A completion also carries the sender's outcome. */
export const InteractionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["message", "assignment", "event", "instruction"] as const),
    ...interactionParties
  }),
  Schema.Struct({
    kind: Schema.Literal("completion"),
    outcome: Schema.Literals([
      "completed",
      "failed",
      "cancelled",
      "needs_attention",
      "interrupted"
    ] as const),
    ...interactionParties
  })
])

export const AgentResultSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  content: Schema.String,
  /** One readable line from the report, for a row that only glances at it. */
  preview: optionalString
})
