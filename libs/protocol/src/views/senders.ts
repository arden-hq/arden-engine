import { INTERACTION_KIND, INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
import { INTERACTION_REFERENCE, SENDER_CAUSE, type InteractionSender } from "../chat/history.js"

export interface WorkMessageFacts {
  readonly role: string
  readonly forwarded: boolean
  readonly carriesWork: boolean
  readonly sender: WorkMessageSender
}

export const WORK_MESSAGE_SENDER = {
  unattributed: "unattributed",
  attributed: "attributed"
} as const

export const CHAT_ORIGIN = { direct: "direct", fromChat: "from_chat" } as const

export type WorkMessageSender =
  | { readonly kind: typeof WORK_MESSAGE_SENDER.unattributed }
  | {
      readonly kind: typeof WORK_MESSAGE_SENDER.attributed
      readonly sender: InteractionSender
      readonly origin: ChatOrigin
    }

export type ChatOrigin =
  | { readonly kind: typeof CHAT_ORIGIN.direct }
  | { readonly kind: typeof CHAT_ORIGIN.fromChat; readonly sessionRef: string }

export function isInternalWorkMessage(message: WorkMessageFacts): boolean {
  if (message.role !== ROLE.interaction || message.forwarded) return false
  if (message.carriesWork) return true
  if (message.sender.kind === WORK_MESSAGE_SENDER.unattributed) return false
  const { sender, origin } = message.sender
  if (sender.from.source !== INTERACTION_SOURCE.agent) return false
  if (sender.kind === INTERACTION_KIND.completion) return true
  if (origin.kind === CHAT_ORIGIN.fromChat && origin.sessionRef === sender.from.id) return false
  return sender.kind === INTERACTION_KIND.message
}

export function isSenderArrival(sender: InteractionSender | undefined): boolean {
  if (sender === undefined || sender.kind === INTERACTION_KIND.assignment) return false
  switch (sender.from.source) {
    case INTERACTION_SOURCE.agent:
    case INTERACTION_SOURCE.workflow:
    case INTERACTION_SOURCE.tool:
      return true
    case INTERACTION_SOURCE.automation:
    case INTERACTION_SOURCE.harness:
      return false
  }
}

export function isAgentInstruction(
  sender: InteractionSender | undefined,
  parentSessionRef: string | undefined
): boolean {
  return (
    sender?.from.source === INTERACTION_SOURCE.agent &&
    (sender.kind === INTERACTION_KIND.assignment ||
      (sender.kind === INTERACTION_KIND.message &&
        causedByToolCall(sender) &&
        parentSessionRef !== undefined &&
        sender.from.id === parentSessionRef))
  )
}

export function isCommandArrival(sender: InteractionSender): boolean {
  return sender.from.source === INTERACTION_SOURCE.tool
}

export function isCorrespondence(sender: InteractionSender | undefined): boolean {
  if (sender === undefined || !isSenderArrival(sender)) return false
  return sender.kind === INTERACTION_KIND.message && causedByToolCall(sender)
}

export function causedByToolCall(sender: InteractionSender): boolean {
  return (
    sender.caused_by.kind === SENDER_CAUSE.traced &&
    sender.caused_by.reference.type === INTERACTION_REFERENCE.toolCall
  )
}
