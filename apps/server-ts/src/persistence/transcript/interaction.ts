import {
  INTERACTION_KIND,
  INTERACTION_KINDS,
  INTERACTION_OUTCOMES,
  INTERACTION_SOURCES,
  ROLE
} from "@arden-hq/std/message-vocabulary"
import {
  ACTOR_NAME,
  INTERACTION_PREVIEW,
  RUN_CAUSE,
  SENDER_ADDRESS,
  SENDER_CAUSE,
  type AgentResult,
  type InteractionPreview,
  type InteractionSender,
  type RunCause
} from "@arden-hq/protocol/chat"
import type { InteractionKind } from "@arden-hq/loop"
import { Option, Schema } from "effect"
import { evidenceText } from "./content.js"

export const StoredActorSchema = Schema.Struct({
  source: Schema.Literals(INTERACTION_SOURCES),
  id: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.String)
})

export const StoredRecipientSchema = Schema.Struct({
  source: Schema.Literal("agent"),
  id: Schema.NonEmptyString
})

export const StoredReferenceSchema = Schema.Struct({
  type: Schema.Literals(["message", "run", "tool_call", "workflow"] as const),
  id: Schema.NonEmptyString
})

const storedSenderFields = {
  from: StoredActorSchema,
  to: Schema.optionalKey(StoredRecipientSchema),
  preview: Schema.optionalKey(Schema.String),
  caused_by: Schema.optionalKey(StoredReferenceSchema)
}

const kinds = INTERACTION_KINDS.filter(
  (kind): kind is Exclude<InteractionKind, "completion"> => kind !== INTERACTION_KIND.completion
)

export const StoredInteractionSenderSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(kinds), ...storedSenderFields }),
  Schema.Struct({
    kind: Schema.Literal(INTERACTION_KIND.completion),
    outcome: Schema.Literals(INTERACTION_OUTCOMES),
    ...storedSenderFields
  })
])

export type StoredInteractionSender = typeof StoredInteractionSenderSchema.Type

export type StoredInteraction = StoredInteractionSender & { readonly content: string }

export const StoredAgentResultSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  content: Schema.String,
  preview: Schema.optionalKey(Schema.String)
})

export type StoredAgentResult = typeof StoredAgentResultSchema.Type

export const interactionPreview = (text: string | null | undefined): InteractionPreview =>
  text === null || text === undefined
    ? { kind: INTERACTION_PREVIEW.unpreviewed }
    : { kind: INTERACTION_PREVIEW.previewed, text }

export const wireSender = (sender: StoredInteractionSender): InteractionSender => {
  const shared = {
    from: {
      source: sender.from.source,
      id: sender.from.id,
      name:
        sender.from.name === undefined
          ? { kind: ACTOR_NAME.unnamed }
          : { kind: ACTOR_NAME.named, text: sender.from.name }
    },
    to:
      sender.to === undefined
        ? { kind: SENDER_ADDRESS.unaddressed }
        : { kind: SENDER_ADDRESS.addressed, recipient: sender.to },
    preview: interactionPreview(sender.preview),
    caused_by:
      sender.caused_by === undefined
        ? { kind: SENDER_CAUSE.untraced }
        : { kind: SENDER_CAUSE.traced, reference: sender.caused_by }
  } as const
  return sender.kind === INTERACTION_KIND.completion
    ? { ...shared, kind: sender.kind, outcome: sender.outcome }
    : { ...shared, kind: sender.kind }
}

export const wireAgentResult = (result: StoredAgentResult): AgentResult => ({
  session_id: result.session_id,
  name: result.name,
  content: result.content,
  preview: interactionPreview(result.preview)
})

const decodeStoredSender = Schema.decodeUnknownOption(StoredInteractionSenderSchema)

export const senderOf = (message: {
  readonly role: string
  readonly content?: unknown
}): StoredInteractionSender | undefined =>
  message.role === ROLE.interaction ? Option.getOrUndefined(decodeStoredSender(message)) : undefined

export const wireSenderOf = (message: {
  readonly role: string
  readonly content?: unknown
}): InteractionSender | undefined => {
  const sender = senderOf(message)
  return sender === undefined ? undefined : wireSender(sender)
}

export const startedBy = (
  sender: StoredInteractionSender | undefined,
  content: unknown
): ReadonlyArray<RunCause> =>
  sender === undefined
    ? []
    : [
        {
          kind: RUN_CAUSE.interaction,
          interaction: { ...wireSender(sender), content: evidenceText(content) }
        }
      ]

type StoredSender = {
  readonly from: {
    readonly source: StoredInteractionSender["from"]["source"]
    readonly id: string
    readonly name?: string
  }
  readonly to?: { readonly source: "agent"; readonly id: string }
  readonly kind: StoredInteractionSender["kind"]
  readonly outcome?: Extract<StoredInteractionSender, { readonly kind: "completion" }>["outcome"]
  readonly preview?: string
  readonly caused_by?: {
    readonly type: NonNullable<StoredInteractionSender["caused_by"]>["type"]
    readonly id: string
  }
}

export const storedSender = (sender: StoredInteractionSender): StoredSender => ({
  from: {
    source: sender.from.source,
    id: sender.from.id,
    ...(sender.from.name === undefined ? {} : { name: sender.from.name })
  },
  ...(sender.to === undefined ? {} : { to: { source: sender.to.source, id: sender.to.id } }),
  kind: sender.kind,
  ...(sender.kind === INTERACTION_KIND.completion ? { outcome: sender.outcome } : {}),
  ...(sender.preview === undefined ? {} : { preview: sender.preview }),
  ...(sender.caused_by === undefined
    ? {}
    : { caused_by: { type: sender.caused_by.type, id: sender.caused_by.id } })
})
