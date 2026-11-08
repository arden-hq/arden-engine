import type { ChatMessage, ToolCall } from "../contracts/messages.js"

export const projectToolHistory = (options: {
  readonly messages: ReadonlyArray<ChatMessage>
  readonly nativeAsync: boolean
}): ReadonlyArray<ChatMessage> => {
  const converted = new Map<string, ToolCall>()
  const output: ChatMessage[] = []
  for (const original of options.messages) {
    if (original.role === "user" && original.async_tool_launch !== undefined) continue
    if (original.role === "assistant") {
      const calls = original.tool_calls ?? []
      const portable = calls.filter((call) => call.async === true && !options.nativeAsync)
      for (const call of portable) converted.set(call.id, call)
      if (portable.length === 0) output.push(original)
      else {
        output.push({
          ...original,
          tool_calls: calls.map((call) => {
            if (!converted.has(call.id)) return call
            const { async: _, ...rest } = call
            return rest
          })
        })
        for (const call of portable)
          output.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              status: "running",
              tool_call_id: call.id,
              instruction: "The result will arrive in an internal completion message."
            })
          })
      }
      continue
    }
    if (original.role === "tool") {
      const call = converted.get(original.tool_call_id)
      if (call !== undefined) {
        output.push({
          role: "user",
          is_meta: true,
          client_id: `async-result:${call.id}`,
          content: [
            {
              type: "context",
              content_type: "async_tool_result",
              content: original.content,
              metadata: { tool_call_id: call.id, tool_name: call.function.name }
            }
          ]
        })
      } else output.push(original)
      continue
    }
    output.push(original)
  }
  return output
}
