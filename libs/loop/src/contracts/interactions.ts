import { INTERACTION_KIND, INTERACTION_SOURCE } from "@arden-hq/std/message-vocabulary"
import type { InteractionMessage } from "./messages.js"

export const isAgentMail = (message: InteractionMessage): boolean =>
  message.from.source === INTERACTION_SOURCE.agent &&
  message.to !== undefined &&
  (message.kind === INTERACTION_KIND.message ||
    message.kind === INTERACTION_KIND.assignment ||
    message.kind === INTERACTION_KIND.completion)

export const rendersAsText = (message: InteractionMessage): boolean => {
  switch (message.from.source) {
    case INTERACTION_SOURCE.agent:
    case INTERACTION_SOURCE.workflow:
    case INTERACTION_SOURCE.tool:
      return true
    case INTERACTION_SOURCE.automation:
    case INTERACTION_SOURCE.harness:
      return false
  }
}
