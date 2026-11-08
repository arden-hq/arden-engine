import type { ChatMessage, ContextContent } from "@arden-hq/loop"

// Providers carry the call id out of band (the Responses API's `call_id`), so
// the model never reads it; this puts it in front of each result the model
// could bind.

const toolResultIdLine = (toolCallId: string): string => `[call id: ${toolCallId}]`

const looksLikeJson = (content: string): boolean => {
  const first = content.trimStart()[0]
  return first === "{" || first === "["
}

const asyncResultBlock = (message: ChatMessage): ContextContent | undefined => {
  if (message.role !== "user" || !Array.isArray(message.content)) return undefined
  return message.content.find(
    (block): block is ContextContent =>
      block.type === "context" &&
      block.content_type === "async_tool_result" &&
      typeof block.metadata?.tool_call_id === "string"
  )
}

export const labelToolResults = (
  messages: ReadonlyArray<ChatMessage>
): ReadonlyArray<ChatMessage> =>
  messages.map((message) => {
    if (message.role === "tool" && looksLikeJson(message.content)) {
      return {
        ...message,
        content: `${toolResultIdLine(message.tool_call_id)}\n${message.content}`
      }
    }
    const block = asyncResultBlock(message)
    const callId = block?.metadata?.tool_call_id
    if (
      message.role !== "user" ||
      !Array.isArray(message.content) ||
      block === undefined ||
      callId === undefined ||
      typeof block.content !== "string" ||
      !looksLikeJson(block.content)
    )
      return message
    return {
      ...message,
      content: message.content.map((item) =>
        item === block
          ? { ...block, content: `${toolResultIdLine(callId)}\n${block.content}` }
          : item
      )
    }
  })

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
    const block = asyncResultBlock(message)
    if (block?.metadata?.tool_call_id === toolCallId && typeof block.content === "string")
      return block.content
  }
  return undefined
}
