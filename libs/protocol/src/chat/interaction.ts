import { INTERACTION_KIND, type InteractionKind } from "@arden-hq/std/message-vocabulary"
import { Schema } from "effect"

import {
  ACTOR_NAME,
  INTERACTION_KINDS,
  INTERACTION_OUTCOMES,
  INTERACTION_PREVIEW,
  INTERACTION_REFERENCE,
  INTERACTION_SOURCES,
  SENDER_ADDRESS,
  SENDER_CAUSE,
  type Interaction,
  type InteractionSender
} from "./history.js"

const tagged = <const Tag extends string>(kind: Tag) =>
  Schema.Struct({ kind: Schema.Literal(kind) })

export const InteractionActorSchema = Schema.Struct({
  source: Schema.Literals(INTERACTION_SOURCES),
  id: Schema.NonEmptyString,
  name: Schema.Union([
    tagged(ACTOR_NAME.unnamed),
    Schema.Struct({ kind: Schema.Literal(ACTOR_NAME.named), text: Schema.String })
  ])
})

export const InteractionRecipientSchema = Schema.Struct({
  source: Schema.Literal("agent"),
  id: Schema.NonEmptyString
})

export const InteractionReferenceSchema = Schema.Struct({
  type: Schema.Literals(Object.values(INTERACTION_REFERENCE)),
  id: Schema.NonEmptyString
})

export const InteractionPreviewSchema = Schema.Union([
  tagged(INTERACTION_PREVIEW.unpreviewed),
  Schema.Struct({ kind: Schema.Literal(INTERACTION_PREVIEW.previewed), text: Schema.String })
])

const senderFields = {
  from: InteractionActorSchema,
  to: Schema.Union([
    tagged(SENDER_ADDRESS.unaddressed),
    Schema.Struct({
      kind: Schema.Literal(SENDER_ADDRESS.addressed),
      recipient: InteractionRecipientSchema
    })
  ]),
  preview: InteractionPreviewSchema,
  caused_by: Schema.Union([
    tagged(SENDER_CAUSE.untraced),
    Schema.Struct({
      kind: Schema.Literal(SENDER_CAUSE.traced),
      reference: InteractionReferenceSchema
    })
  ])
}

const kinds = INTERACTION_KINDS.filter(
  (kind): kind is Exclude<InteractionKind, typeof INTERACTION_KIND.completion> =>
    kind !== INTERACTION_KIND.completion
)

export const interactionSenderFields = [
  { kind: Schema.Literals(kinds), ...senderFields },
  {
    kind: Schema.Literal(INTERACTION_KIND.completion),
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
  preview: InteractionPreviewSchema
})
