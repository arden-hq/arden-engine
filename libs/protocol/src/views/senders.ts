import { INTERACTION_KIND, INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
import type { AgentResult, InteractionSender } from "../chat/history.js"
import type { ChatUpdate, CommunicationEnvelope } from "../chat/communication.js"

/** Stored work input remains available to the main agent, never published as its answer. */
export function isInternalWorkMessage(message: {
  readonly role: string
  readonly sender?: InteractionSender | undefined
  readonly communication?: CommunicationEnvelope | undefined
  readonly update?: ChatUpdate | undefined
  readonly agentResult?: AgentResult | undefined
  readonly fromChat?: { readonly sessionRef: string } | undefined
  readonly forwardedFrom?: { readonly messageId: string } | undefined
}): boolean {
  if (message.role !== ROLE.interaction || message.forwardedFrom !== undefined) return false
  if (
    message.communication !== undefined ||
    message.update !== undefined ||
    message.agentResult !== undefined
  )
    return true
  const sender = message.sender
  if (sender?.from.source !== INTERACTION_SOURCE.agent) return false
  if (sender.kind === INTERACTION_KIND.completion) return true
  if (message.fromChat?.sessionRef === sender.from.id) return false
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
  { parentSessionRef }: { readonly parentSessionRef?: string | undefined } = {}
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
