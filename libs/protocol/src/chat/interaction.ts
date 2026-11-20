import { Schema } from "effect"
import { optionalString } from "../common/schema.js"

import {
  INTERACTION_KINDS,
  INTERACTION_OUTCOMES,
  INTERACTION_SOURCES,
  type Interaction,
  type InteractionSender
} from "./history.js"

export const InteractionActorSchema = Schema.Struct({
  source: Schema.Literals(INTERACTION_SOURCES),
  id: Schema.NonEmptyString,
  name: optionalString
})

export const InteractionRecipientSchema = Schema.Struct({
  source: Schema.Literal("agent"),
  id: Schema.NonEmptyString
})

export const InteractionReferenceSchema = Schema.Struct({
  type: Schema.Literals(["message", "run", "tool_call", "workflow"] as const),
  id: Schema.NonEmptyString
})

const senderFields = {
  from: InteractionActorSchema,
  to: Schema.optionalKey(InteractionRecipientSchema),
  preview: optionalString,
  caused_by: Schema.optionalKey(InteractionReferenceSchema)
}

const kinds = INTERACTION_KINDS.filter(
  (kind): kind is Exclude<(typeof INTERACTION_KINDS)[number], "completion"> => kind !== "completion"
)

export const interactionSenderFields = [
  { kind: Schema.Literals(kinds), ...senderFields },
  {
    kind: Schema.Literal("completion"),
    outcome: Schema.Literals(INTERACTION_OUTCOMES),
    ...senderFields
  }
] as const

export const InteractionSenderSchema: Schema.Codec<InteractionSender> = Schema.Union([
  Schema.Struct(interactionSenderFields[0]),
  Schema.Struct(interactionSenderFields[1])
])

export const InteractionSchema: Schema.Codec<Interaction> = Schema.Union([
  Schema.Struct({ ...interactionSenderFields[0], content: Schema.String }),
  Schema.Struct({ ...interactionSenderFields[1], content: Schema.String })
])

export const AgentResultSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  content: Schema.String,
  /** One readable line from the report, for a row that only glances at it. */
  preview: optionalString
})
