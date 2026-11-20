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
  if (message.role !== "interaction" || message.forwardedFrom !== undefined) return false
  if (
    message.communication !== undefined ||
    message.update !== undefined ||
    message.agentResult !== undefined
  )
    return true
  const sender = message.sender
  if (sender?.from.source !== "agent") return false
  if (sender.kind === "completion") return true
  if (message.fromChat?.sessionRef === sender.from.id) return false
  return sender.kind === "message"
}

/** An arrival the harness delivered on someone else's behalf: an agent, a
 *  Workflow, or a command Arden left running. Harness instructions (the goal
 *  nudge) are not one, nor is an assignment, which is the opening prompt of
 *  the agent's own chat. */
export function isSenderArrival(sender: InteractionSender | undefined): boolean {
  if (sender === undefined || sender.kind === "assignment") return false
  switch (sender.from.source) {
    case "agent":
    case "workflow":
    case "tool":
      return true
    case "automation":
    case "harness":
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
    sender?.from.source === "agent" &&
    (sender.kind === "assignment" ||
      (sender.kind === "message" &&
        sender.caused_by?.type === "tool_call" &&
        parentSessionRef !== undefined &&
        sender.from.id === parentSessionRef))
  )
}

export function isCommandArrival(sender: InteractionSender): boolean {
  return sender.from.source === "tool"
}

/** A tool-mediated sender message, used to group activity within its turn. */
export function isCorrespondence(sender: InteractionSender | undefined): boolean {
  if (sender === undefined || !isSenderArrival(sender)) return false
  return sender.kind === "message" && sender.caused_by?.type === "tool_call"
}
