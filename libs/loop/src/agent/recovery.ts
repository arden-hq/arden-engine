import { parseToolCalls } from "../tools/dispatch.js"
import type { ChatMessage, ToolCall } from "../contracts/messages.js"
import type { PendingToolCall, ToolDisplayTitle } from "../contracts/tools.js"

export interface IncompleteToolStep {
  readonly rawToolCalls: ReadonlyArray<ToolCall>
  readonly pendingCalls: ReadonlyArray<PendingToolCall>
}

export const incompleteToolStep = (
  messages: ReadonlyArray<ChatMessage>,
  displayTitle: ToolDisplayTitle | undefined
): IncompleteToolStep | null => {
  const completedIds = new Set<string>()
  const rawToolCalls: ToolCall[] = []
  for (const message of [...messages].reverse()) {
    if (message.role === "user" && message.async_tool_launch !== undefined) {
      completedIds.add(message.async_tool_launch.call_id)
      continue
    }
    if (message.role === "tool") {
      completedIds.add(message.tool_call_id)
      continue
    }
    if (message.role !== "assistant") continue
    rawToolCalls.unshift(...(message.tool_calls ?? []))
  }
  const pendingCalls = parseToolCalls(rawToolCalls, displayTitle).filter(
    (call) => !completedIds.has(call.toolCall.id)
  )
  return pendingCalls.length === 0 ? null : { rawToolCalls, pendingCalls }
}
