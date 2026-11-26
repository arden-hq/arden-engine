import {
  INTERACTION_KIND,
  INTERACTION_OUTCOME,
  INTERACTION_SOURCE,
  type InteractionOutcome
} from "@arden-hq/std/message-vocabulary"
import { ARRIVAL_EVENT, UPDATE_WEIGHT, type ChatUpdate } from "@arden-hq/protocol/chat"
import type { StoredInteraction } from "../transcript/interaction.js"
import type { RunDeliveryPayload } from "./model.js"
import { doorRef } from "../transcript/chat-events.js"

export const updateInteraction = (
  payload: Extract<RunDeliveryPayload, { readonly kind: "update" }>,
  body: string
): StoredInteraction => ({
  kind: INTERACTION_KIND.completion,
  from: {
    source: INTERACTION_SOURCE.agent,
    id: doorRef(payload.update.door, null),
    name: payload.update.door.label
  },
  to: { source: INTERACTION_SOURCE.agent, id: payload.sessionId },
  content: body,
  outcome: updateOutcome(payload.update)
})

const updateOutcome = (update: ChatUpdate): InteractionOutcome => {
  if (update.weight === UPDATE_WEIGHT.news) return INTERACTION_OUTCOME.completed
  return update.event === ARRIVAL_EVENT.failed
    ? INTERACTION_OUTCOME.failed
    : INTERACTION_OUTCOME.needsAttention
}
