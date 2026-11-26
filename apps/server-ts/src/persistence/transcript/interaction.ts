import { INTERACTION_KIND, ROLE } from "@arden-hq/std/message-vocabulary"
import { RUN_CAUSE, type InteractionSender, type RunCause } from "@arden-hq/protocol/chat"
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

export const startedBy = (
  sender: InteractionSender | undefined,
  content: unknown
): ReadonlyArray<RunCause> =>
  sender === undefined
    ? []
    : [
        {
          kind: RUN_CAUSE.interaction,
          interaction: { ...sender, content: evidenceText(content) }
        }
      ]

type StoredSender = {
  readonly from: {
    readonly source: InteractionSender["from"]["source"]
    readonly id: string
    readonly name?: string
  }
  readonly to?: { readonly source: "agent"; readonly id: string }
  readonly kind: InteractionSender["kind"]
  readonly outcome?: Extract<InteractionSender, { readonly kind: "completion" }>["outcome"]
  readonly preview?: string
  readonly caused_by?: {
    readonly type: NonNullable<InteractionSender["caused_by"]>["type"]
    readonly id: string
  }
}

export const storedSender = (sender: InteractionSender): StoredSender => ({
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
