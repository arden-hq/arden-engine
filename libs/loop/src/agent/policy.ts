import { messageId, type ChatMessage, type ToolCall } from "../contracts/messages.js"
import {
  callEndsTurn,
  type PendingToolCall,
  type ToolMeta,
  type ToolResult
} from "../contracts/tools.js"
import {
  StopReason,
  type RunBudgetSnapshot,
  type RunPolicy,
  type ToolCompleted
} from "../contracts/events.js"
import type { AgentConfig } from "./config.js"
import { normalizeToolResult } from "../internal/validate.js"

interface BudgetStopInput {
  readonly config: AgentConfig
  readonly budget: RunBudgetSnapshot
  readonly startedAtMs: number
  readonly nowMs: number
  readonly cost: number
}

export const budgetStopReason = (input: BudgetStopInput): StopReason | null => {
  if (
    input.config.maxToolCalls !== undefined &&
    input.budget.toolCalls >= input.config.maxToolCalls
  ) {
    return StopReason.MAX_TOOL_CALLS
  }
  if (
    input.config.maxWallTimeMs !== undefined &&
    input.nowMs - input.startedAtMs >= input.config.maxWallTimeMs
  ) {
    return StopReason.MAX_WALL_TIME
  }
  if (input.config.maxCost !== undefined && input.cost >= input.config.maxCost)
    return StopReason.MAX_COST
  if (
    input.budget.totalOutputTokens !== undefined &&
    input.budget.outputTokens >= input.budget.totalOutputTokens
  )
    return StopReason.MAX_TOKEN_BUDGET
  return null
}

export const turnEndingToolBatchRejection = (
  calls: ReadonlyArray<PendingToolCall>,
  metas: ReadonlyMap<string, ToolMeta>
): ToolResult | null => {
  if (calls.length > 1 && calls.some((call) => callEndsTurn(metas.get(call.name), call.args))) {
    return {
      content:
        "Not run: a turn-ending tool must be the only call in its step. " +
        "Call it again by itself once the other work is done and its results are in.",
      preview: "Call it by itself",
      is_error: true,
      retryable: false
    }
  }
  return null
}

export interface TurnEndingBatchRefusal {
  readonly rejection: ToolResult
  readonly refused: ReadonlyArray<PendingToolCall>
  readonly refusedRaw: ReadonlyArray<ToolCall>
}

export const turnEndingBatchRefusal = (
  calls: ReadonlyArray<PendingToolCall>,
  rawCalls: ReadonlyArray<ToolCall>,
  metas: ReadonlyMap<string, ToolMeta>
): TurnEndingBatchRefusal | null => {
  const rejection = turnEndingToolBatchRejection(calls, metas)
  if (rejection === null) return null
  const refused = calls.filter((call) => callEndsTurn(metas.get(call.name), call.args))
  const refusedIds = new Set(refused.map((call) => call.toolCall.id))
  return { rejection, refused, refusedRaw: rawCalls.filter((call) => refusedIds.has(call.id)) }
}

export const nextNoProgressCount = (
  current: number,
  completions: ReadonlyArray<ToolCompleted>
): number => {
  if (completions.length === 0) return 0
  return completions.every((event) => event.is_error && event.retryable === false) ? current + 1 : 0
}

export const terminalCompletionText = (
  completions: ReadonlyArray<ToolCompleted>
): string | undefined => {
  const terminal = completions.find((event) => event.ends_turn && !event.is_error)
  if (terminal === undefined) return undefined
  return terminal.result.trim() || terminal.preview.trim() || undefined
}

export const budgetDenialResult = (reason: StopReason, policy: RunPolicy): Required<ToolResult> =>
  normalizeToolResult({
    content:
      policy.budgetDenialContent?.(reason) ??
      `Tool call denied: the run hit its ${reason.replaceAll("_", " ")} limit. Stop calling tools and summarize.`,
    preview: "Tool call denied",
    is_error: true,
    retryable: false
  })

const appendDenials = (
  messages: ChatMessage[],
  calls: ReadonlyArray<ToolCall>,
  content: string
): void => {
  for (const call of calls) {
    messages.push({
      message_id: messageId("tool"),
      role: "tool",
      tool_call_id: call.id,
      content
    })
  }
}

export const appendBudgetDenials = (
  messages: ChatMessage[],
  calls: ReadonlyArray<ToolCall>,
  reason: StopReason,
  policy: RunPolicy
): void => appendDenials(messages, calls, budgetDenialResult(reason, policy).content)

/** Consecutive replies cut off at the output limit that the run continues past before it stops. */
export const maxOutputLimitContinuations = 2

/**
 * Continues a run whose reply the provider cut off at the output limit: calls the reply did not
 * finish are answered as not run, and one meta message asks the model to go on.
 */
export const appendOutputLimitContinuation = (
  messages: ChatMessage[],
  calls: ReadonlyArray<ToolCall>
): void => {
  appendDenials(
    messages,
    calls,
    "Not run: the reply was cut off at the output token limit before this call was sent. " +
      "Make the call again, with shorter arguments if it was long."
  )
  messages.push({
    role: "user",
    message_id: messageId("text"),
    is_meta: true,
    content:
      "Your last reply was cut off at the output token limit. Continue from where it stopped " +
      "and do not repeat what you already wrote. Split the remaining work into smaller steps."
  })
}

export const withBudgetReminder = (
  messages: ReadonlyArray<ChatMessage>,
  reminder: string
): ReadonlyArray<ChatMessage> => {
  const first = messages[0]
  if (first?.role !== "system") return [{ role: "system", content: reminder }, ...messages]
  const content = first.content
  const system =
    typeof content === "string"
      ? { ...first, content: `${content}\n\n${reminder}` }
      : { ...first, content: [...content, { type: "text", text: reminder }] }
  return [system, ...messages.slice(1)]
}

export const recoveredTerminalText = (
  calls: ReadonlyArray<PendingToolCall>,
  recovered: ReadonlyMap<string, Required<ToolResult>>,
  metas: ReadonlyMap<string, ToolMeta>
): string | undefined => {
  for (const call of calls) {
    const result = recovered.get(call.toolCall.id)
    if (!callEndsTurn(metas.get(call.name), call.args) || result === undefined || result.is_error)
      continue
    const text = result.content.trim() || result.preview.trim()
    if (text.length > 0) return text
  }
  return undefined
}
