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
    isMeta: true,
    interaction: {
      kind: "message",
      from: {
        type: "agent",
        id: input.source.publicRef,
        ...(name ? { display_name: name } : {})
      },
      to: { type: "agent", id: input.targetRef },
      content: input.message,
      causedBy: { type: "tool_call", id: input.toolCallId }
    },
    fromChat: { sessionId: input.source.sessionId, sessionRef: input.source.publicRef }
  }
}
