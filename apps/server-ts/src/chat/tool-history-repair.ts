import type { ChatMessage } from "@arden-hq/loop"

export interface OrphanToolOutput {
  readonly callId: string
  readonly messageId: string | undefined
}

export interface ToolHistoryRepair {
  readonly messages: ReadonlyArray<ChatMessage>
  readonly orphans: ReadonlyArray<OrphanToolOutput>
}

export const repairOrphanToolOutputs = (
  messages: ReadonlyArray<ChatMessage>
): ToolHistoryRepair => {
  const open = new Set<string>()
  const orphans: Array<OrphanToolOutput> = []
  const repaired = messages.map((message): ChatMessage => {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) open.add(call.id)
      return message
    }
    if (message.role !== "tool" || open.delete(message.tool_call_id)) return message
    orphans.push({ callId: message.tool_call_id, messageId: message.message_id })
    return {
      role: "user",
      is_meta: true,
      ...(message.message_id === undefined ? {} : { message_id: message.message_id }),
      content: [
        {
          type: "context",
          content_type: "earlier_tool_result",
          metadata: {
            call_id: message.tool_call_id,
            note: "The call that produced this result was summarized out of this conversation."
          },
          content: message.content
        }
      ]
    }
  })
  return { messages: orphans.length === 0 ? messages : repaired, orphans }
}
