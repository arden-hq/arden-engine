import type { ChatMessage } from "@arden-hq/loop"

// Providers carry the call id out of band (the Responses API's `call_id`), so
// the model never reads it; this puts it in front of each result the model
// could bind.

const toolResultIdLine = (toolCallId: string): string => `[call id: ${toolCallId}]`

const looksLikeJson = (content: string): boolean => {
  const first = content.trimStart()[0]
  return first === "{" || first === "["
}

export const labelToolResults = (
  messages: ReadonlyArray<ChatMessage>
): ReadonlyArray<ChatMessage> =>
  messages.map((message) =>
    message.role === "tool" && looksLikeJson(message.content)
      ? { ...message, content: `${toolResultIdLine(message.tool_call_id)}\n${message.content}` }
      : message
  )

export const seenToolResult = (
  messages: ReadonlyArray<ChatMessage>,
  toolCallId: string
): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined) continue
    if (
      message.role === "tool" &&
      message.tool_call_id === toolCallId &&
      message.async_tool_launch === undefined
    )
      return message.content
  }
  return undefined
}
