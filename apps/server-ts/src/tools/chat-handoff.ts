import { INTERACTION_KIND, INTERACTION_SOURCE } from "@arden-hq/std/message-vocabulary"
import type { ChatRunnerSendMessageRequest } from "../chat/runner-contract.js"
import type { SessionHistoryHeader } from "../persistence/sessions/model.js"

export const chatHandoff = (input: {
  readonly source: Pick<SessionHistoryHeader, "sessionId" | "publicRef" | "name">
  readonly targetRef: string
  readonly message: string
  readonly clientId: string
  readonly toolCallId: string
}): Omit<ChatRunnerSendMessageRequest, "sessionId"> => {
  const name = input.source.name?.trim()
  return {
    clientId: input.clientId,
    message: input.message,
    sender: {
      kind: INTERACTION_KIND.message,
      from: {
        source: INTERACTION_SOURCE.agent,
        id: input.source.publicRef,
        ...(name ? { name } : {})
      },
      to: { source: INTERACTION_SOURCE.agent, id: input.targetRef },
      caused_by: { type: "tool_call", id: input.toolCallId }
    },
    fromChat: { sessionId: input.source.sessionId, sessionRef: input.source.publicRef }
  }
}
