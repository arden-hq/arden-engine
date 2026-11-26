import { INTERACTION_KIND, INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
import type { InteractionSender } from "../chat/history.js"

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
  | { readonly kind: "unattributed" }
  | { readonly kind: "attributed"; readonly sender: InteractionSender; readonly origin: ChatOrigin }

export type ChatOrigin =
  | { readonly kind: "direct" }
  | { readonly kind: "from_chat"; readonly sessionRef: string }

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

/** An arrival the harness delivered on someone else's behalf: an agent, a
 *  Workflow, or a command Arden left running. Harness instructions (the goal
 *  nudge) are not one, nor is an assignment, which is the opening prompt of
 *  the agent's own chat. */
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

/** An assignment or a follow-up from this agent's recorded parent. A tool call
 * alone says nothing about direction: child and sibling updates use it too. */
export function isAgentInstruction(
  sender: InteractionSender | undefined,
  parentSessionRef: string | undefined
): boolean {
  return (
    sender?.from.source === INTERACTION_SOURCE.agent &&
    (sender.kind === INTERACTION_KIND.assignment ||
      (sender.kind === INTERACTION_KIND.message &&
        sender.caused_by?.type === "tool_call" &&
        parentSessionRef !== undefined &&
        sender.from.id === parentSessionRef))
  )
}

export function isCommandArrival(sender: InteractionSender): boolean {
  return sender.from.source === INTERACTION_SOURCE.tool
}

/** A tool-mediated sender message, used to group activity within its turn. */
export function isCorrespondence(sender: InteractionSender | undefined): boolean {
  if (sender === undefined || !isSenderArrival(sender)) return false
  return sender.kind === INTERACTION_KIND.message && sender.caused_by?.type === "tool_call"
}
