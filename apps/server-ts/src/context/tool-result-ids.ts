import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ChatMessage } from "@arden-hq/loop"

const toolResultIdLine = (toolCallId: string): string => `[call id: ${toolCallId}]`

const looksLikeJson = (content: string): boolean => {
  const first = content.trimStart()[0]
  return first === "{" || first === "["
}

export const labelToolResults = (
  messages: ReadonlyArray<ChatMessage>
): ReadonlyArray<ChatMessage> =>
  messages.map((message) =>
    message.role === ROLE.tool && looksLikeJson(message.content)
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
      message.role === ROLE.tool &&
      message.tool_call_id === toolCallId &&
      message.async_tool_launch === undefined
    )
      return message.content
  }
  return undefined
}
