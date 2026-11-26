import { usageInputTokens } from "../contracts/provider.js"
import {
  StopReason,
  type PendingToolRequest,
  type Result,
  type ToolPaused
} from "../contracts/events.js"
import { hookCall, invoke } from "./guards.js"
import { currentCost } from "./run-cost.js"
import { type Run } from "./run-state.js"

const result = async (
  run: Run,
  text: string,
  reason: StopReason,
  steps: number,
  pausedTools: ReadonlyArray<PendingToolRequest>
): Promise<Result> => {
  const { wiring, state, messages } = run
  const fallback = wiring.config.policy.fallbackResultText
  const finalText =
    reason !== StopReason.END_TURN &&
    reason !== StopReason.PAUSED &&
    text.trim().length === 0 &&
    fallback !== undefined
      ? invoke("policy.fallbackResultText", () => fallback(messages, reason) || text)
      : text
  const nowMs = invoke("clock", wiring.clock)
  const cost = await currentCost(run)
  state.resultText = finalText
  return {
    text: finalText,
    ...(state.structuredObject === null ? {} : { object: state.structuredObject.value }),
    stop_reason: reason,
    steps,
    usage: state.usage,
    last_input_tokens:
      state.lastResponse === null ? null : usageInputTokens(state.lastResponse.usage),
    cost,
    duration_ms: Math.max(0, Math.trunc(nowMs - state.startedAtMs)),
    tool_time_ms: state.toolTimeMs,
    paused_tools: [...pausedTools],
    messages: messages.map((message) => structuredClone(message))
  }
}

export const finalize = async (
  run: Run,
  text: string,
  reason: StopReason,
  steps: number,
  pausedTools: ReadonlyArray<PendingToolRequest> = []
): Promise<void> => {
  run.toolsController.abort()
  await run.emit(await result(run, text, reason, steps, pausedTools))
}

const pauseResult = (paused: ReadonlyArray<ToolPaused>): ReadonlyArray<PendingToolRequest> =>
  paused.map((event) => ({
    tool_call_id: event.tool_id,
    name: event.name,
    args: { ...event.args },
    reason: event.reason,
    detail: event.detail
  }))

export const finalizePaused = async (
  run: Run,
  steps: number,
  paused: ReadonlyArray<ToolPaused>
): Promise<void> => {
  const running = run.background.running()
  const hold = run.wiring.hooks.holdBackgroundCalls
  if (running.length > 0 && hold !== undefined) {
    try {
      await hookCall("holdBackgroundCalls", () => hold(running))
    } catch (error) {
      for (const call of running) call.stop()
      throw error
    }
  }
  run.detachBackground()
  await finalize(run, "", StopReason.PAUSED, steps, pauseResult(paused))
}
