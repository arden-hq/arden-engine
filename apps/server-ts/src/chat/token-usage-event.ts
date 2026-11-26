import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { contextSize, contextUsage } from "@arden-hq/protocol/chat"
import type { ChatRunnerContextReport } from "./runner-contract.js"

export const tokenUsageEvent = (
  run: { readonly runId: string; readonly sessionId: string },
  context: ChatRunnerContextReport,
  messageCount: number
): ChatProjectionEvent => ({
  type: "token_usage",
  run_id: run.runId,
  session_id: run.sessionId,
  scope: "run",
  usage: contextUsage(context.usage),
  context: contextSize(context.inputTokens),
  message_count: messageCount
})
