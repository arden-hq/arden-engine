import type { ChatMessage, ContentBlock, ToolCall } from "../contracts/messages.js"

export const projectToolHistory = (options: {
  readonly messages: ReadonlyArray<ChatMessage>
  readonly nativeAsync: boolean
}): ReadonlyArray<ChatMessage> => {
  const calls = new Map<string, ToolCall>()
  const launched = new Set<string>()
  const output: ChatMessage[] = []
  for (const message of options.messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) calls.set(call.id, call)
      output.push(options.nativeAsync ? message : withoutAsyncFlags(message))
      continue
    }
    if (message.role !== "tool") {
      output.push(message)
      continue
    }
    const { model_content: media, ...result } = message
    const toolName = calls.get(message.tool_call_id)?.function.name ?? "unknown"
    const carriedNatively = options.nativeAsync && calls.get(result.tool_call_id)?.async === true
    if (result.async_tool_launch !== undefined) {
      launched.add(result.async_tool_launch.call_id)
      if (!carriedNatively) output.push(result)
    } else if (launched.has(result.tool_call_id) && !carriedNatively) {
      output.push({
        role: "user",
        is_meta: true,
        content: [
          {
            type: "context",
            content_type: "async_tool_result",
            content: result.content,
            metadata: { tool_call_id: result.tool_call_id, tool_name: toolName }
          }
        ]
      })
    } else output.push(result)
    if (media !== undefined && media.length > 0)
      output.push(mediaMessage(result.tool_call_id, toolName, media))
  }
  return output
}

const withoutAsyncFlags = (message: Extract<ChatMessage, { role: "assistant" }>): ChatMessage => {
  const calls = message.tool_calls ?? []
  if (!calls.some((call) => call.async !== undefined)) return message
  return {
    ...message,
    tool_calls: calls.map((call) => {
      const { async: _, ...rest } = call
      return rest
    })
  }
}

const mediaMessage = (
  toolCallId: string,
  toolName: string,
  media: ReadonlyArray<ContentBlock>
): ChatMessage => ({
  role: "user",
  is_meta: true,
  content: [
    {
      type: "context",
      content_type: "tool_result_media",
      content: `Media returned by tool ${toolName}.`,
      metadata: { tool_call_id: toolCallId, tool_name: toolName }
    },
    ...media
  ] as unknown as ReadonlyArray<Record<string, unknown>>
})
