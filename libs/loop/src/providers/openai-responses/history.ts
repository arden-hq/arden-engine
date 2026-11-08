import type { InputItem } from "./items.js"
import { OpenAiResponsesProviderError } from "./errors.js"

export interface InputBatch {
  readonly items: ReadonlyArray<InputItem>
  readonly deferWhileCallsPending: boolean
}

/** Reject malformed durable runtime-tool history before it reaches OpenAI. */
export function validateFunctionCallHistory(
  batches: ReadonlyArray<InputBatch>
): ReadonlyArray<InputItem> {
  const outputs = new Map<InputItem, InputItem>()
  const outstanding = new Map<string, InputItem>()
  for (const batch of batches) {
    for (const item of batch.items) {
      if (item.type === "function_call") {
        const id = requireFunctionCallId(item)
        if (outstanding.has(id)) {
          throw new OpenAiResponsesProviderError(
            `Stored OpenAI tool history contains duplicate function call ${id}`
          )
        }
        outstanding.set(id, item)
      } else if (item.type === "function_call_output") {
        const id = requireFunctionCallId(item)
        const call = outstanding.get(id)
        if (call === undefined) {
          throw new OpenAiResponsesProviderError(
            `Stored OpenAI tool history contains output without matching function call ${id}`
          )
        }
        outputs.set(call, item)
        outstanding.delete(id)
      }
    }
  }
  const calls = new Map<string, InputItem>()
  const consumedOutputs = new Set<InputItem>()
  const pending = new Set<string>()
  const asynchronous = new Set<string>()
  const deferredToolContext: Array<InputItem> = []
  const input: Array<InputItem> = []
  const closeInterruptedCalls = () => {
    for (const callId of pending) {
      const call = calls.get(callId)
      const recorded = call === undefined ? undefined : outputs.get(call)
      if (recorded !== undefined) consumedOutputs.add(recorded)
      input.push(
        recorded ?? {
          type: "function_call_output",
          call_id: callId,
          output:
            "Tool output was not recorded. The call may have been interrupted; check its effects before retrying.",
          status: "completed"
        }
      )
    }
    pending.clear()
    input.push(...deferredToolContext.splice(0))
  }

  for (const batch of batches) {
    if (pending.size > 0 && batch.deferWhileCallsPending) {
      deferredToolContext.push(...batch.items)
      continue
    }
    if (pending.size > 0 && batch.items.some((item) => item.type !== "function_call_output")) {
      closeInterruptedCalls()
    }
    for (const item of batch.items) {
      if (consumedOutputs.has(item)) continue
      if (item.type === "function_call") {
        const callId = requireFunctionCallId(item)
        calls.set(callId, item)
        if (pending.has(callId) || asynchronous.has(callId)) {
          throw new OpenAiResponsesProviderError(
            `Stored OpenAI tool history contains duplicate function call ${callId}`
          )
        }
        if (item.async === true) asynchronous.add(callId)
        else pending.add(callId)
        continue
      }
      if (item.type !== "function_call_output") continue
      const callId = requireFunctionCallId(item)
      if (!pending.has(callId) && !asynchronous.has(callId)) {
        throw new OpenAiResponsesProviderError(
          `Stored OpenAI tool history contains output without matching function call ${callId}`
        )
      }
      pending.delete(callId)
      asynchronous.delete(callId)
    }
    input.push(...batch.items.filter((item) => !consumedOutputs.has(item)))
    if (pending.size === 0 && deferredToolContext.length > 0) {
      input.push(...deferredToolContext.splice(0))
    }
  }

  closeInterruptedCalls()
  return input
}

function requireFunctionCallId(item: InputItem): string {
  if (typeof item.call_id === "string" && item.call_id.length > 0) return item.call_id
  throw new OpenAiResponsesProviderError(
    "Stored OpenAI tool history contains an invalid function call id"
  )
}
