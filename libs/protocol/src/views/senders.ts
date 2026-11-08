import type { AgentResult, Interaction } from "../chat/history.js"
import type { ChatUpdate, CommunicationEnvelope } from "../chat/communication.js"

/** Stored work input remains available to the main agent, never published as its answer. */
export function isInternalWorkMessage(message: {
  readonly role: string
  readonly interaction?: Interaction | undefined
  readonly communication?: CommunicationEnvelope | undefined
  readonly update?: ChatUpdate | undefined
  readonly agentResult?: AgentResult | undefined
  readonly fromChat?: { readonly sessionRef: string } | undefined
  readonly forwardedFrom?: { readonly messageId: string } | undefined
}): boolean {
  if (message.role !== "user" || message.forwardedFrom !== undefined) return false
  if (
    message.communication !== undefined ||
    message.update !== undefined ||
    message.agentResult !== undefined
  )
    return true
  const interaction = message.interaction
  if (interaction?.from.type !== "agent") return false
  if (interaction.kind === "completion") return true
  if (message.fromChat?.sessionRef === interaction.from.id) return false
  return interaction.kind === "message"
}

/** An arrival the harness delivered on someone else's behalf: an agent, a
 *  Workflow, or a command Arden left running. Harness instructions (the goal
 *  nudge) are not one, nor is an assignment, which is the opening prompt of
 *  the agent's own chat. */
export function isSenderArrival(interaction: Interaction | undefined): boolean {
  if (interaction === undefined || interaction.kind === "assignment") return false
  return (
    interaction.from.type === "agent" ||
    interaction.from.type === "workflow" ||
    isCommandArrival(interaction)
  )
}

/** An assignment or a follow-up from this agent's recorded parent. A tool call
 * alone says nothing about direction: child and sibling updates use it too. */
export function isAgentInstruction(
  interaction: Interaction | undefined,
  { parentSessionRef }: { readonly parentSessionRef?: string | undefined } = {}
): boolean {
  return (
    interaction?.from.type === "agent" &&
    (interaction.kind === "assignment" ||
      (interaction.kind === "message" &&
        interaction.causedBy?.type === "tool_call" &&
        parentSessionRef !== undefined &&
        interaction.from.id === parentSessionRef))
  )
}

/** A command Arden left running told it how it ended (exec_command). */
export function isCommandArrival(interaction: Interaction): boolean {
  return interaction.from.type === "tool" && interaction.from.id.startsWith("exec_command:")
}

/** A tool-mediated sender message, used to group activity within its turn. */
export function isCorrespondence(interaction: Interaction | undefined): boolean {
  if (interaction === undefined || !isSenderArrival(interaction)) return false
  return interaction.kind === "message" && interaction.causedBy?.type === "tool_call"
}
