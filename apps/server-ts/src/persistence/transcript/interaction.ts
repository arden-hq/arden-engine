import { INTERACTION_KIND, ROLE } from "@arden-hq/std/message-vocabulary"
import type { InteractionSender } from "@arden-hq/protocol/chat"
import { InteractionSenderSchema } from "@arden-hq/protocol/effect/chat"
import { Option, Schema } from "effect"
import { evidenceText } from "./content.js"

export const senderOf = (message: {
  readonly role: string
  readonly content?: unknown
}): InteractionSender | undefined =>
  message.role === ROLE.interaction
    ? Option.getOrUndefined(Schema.decodeUnknownOption(InteractionSenderSchema)(message))
    : undefined

export const startedBy = (sender: InteractionSender | undefined, content: unknown) =>
  sender === undefined ? {} : { interaction: { ...sender, content: evidenceText(content) } }

export const storedSender = (sender: InteractionSender) => ({
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
