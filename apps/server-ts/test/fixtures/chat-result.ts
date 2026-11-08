import type { Result } from "@arden-hq/loop"
import type { ChatRunnerInput } from "../../src/chat/runner-contract.js"

export const terminalResult = (
  input: ChatRunnerInput,
  text: string,
  pending: ReadonlyArray<ChatRunnerInput["messages"][number]> = []
): Result => ({
  text,
  stop_reason: "end_turn",
  steps: 1,
  usage: {
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0
  },
  last_input_tokens: 0,
  cost: 0,
  duration_ms: 0,
  tool_time_ms: 0,
  paused_tools: [],
  messages: [
    ...input.messages,
    ...pending,
    {
      role: "assistant",
      message_id: `fixture-assistant-${input.runId}`,
      content: text
    }
  ]
})
