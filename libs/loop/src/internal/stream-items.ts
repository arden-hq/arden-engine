import { ROLE } from "@arden-hq/std/message-vocabulary"
import { isRecord } from "@arden-hq/std/json"
import { InvalidModelResponseError, ModelProviderError } from "../errors.js"
import {
  isReasoningPart,
  isTextPart,
  isToolCallPart,
  TOOL_CALL_TYPE,
  TOOL_EXECUTION,
  type AssistantOutputPart,
  type ProviderState,
  type ProviderToolCall,
  type ToolCall,
  type ToolExecution
} from "../contracts/messages.js"
import {
  FinishReason,
  MODEL_STREAM_ITEM_TAG,
  type CompletionResponse,
  type ProviderStreamRetry,
  type OutputItemReady,
  type ToolCallStreamDelta
} from "../contracts/provider.js"
import { isAssistantOutputPart, isMessageOrigin } from "./validate.js"

export type ParsedStreamItem =
  | { readonly _tag: typeof MODEL_STREAM_ITEM_TAG.textDelta; readonly content: string }
  | { readonly _tag: typeof MODEL_STREAM_ITEM_TAG.reasoningDelta; readonly content: string }
  | {
      readonly _tag: typeof MODEL_STREAM_ITEM_TAG.toolCallDelta
      readonly delta: Required<Omit<ToolCallStreamDelta, "_tag">>
    }
  | {
      readonly _tag: typeof MODEL_STREAM_ITEM_TAG.providerToolCall
      readonly call: Required<ProviderToolCall>
    }
  | OutputItemReady
  | ProviderStreamRetry
  | CompletionResponse

const invalidItem = (detail: string): never => {
  throw new ModelProviderError(
    "model provider emitted an invalid stream item",
    new TypeError(detail)
  )
}

const checkStreamRetry = (value: Record<string, unknown>): ProviderStreamRetry => {
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 1) {
    invalidItem("stream retry attempt must be a positive integer")
  }
  if (
    !Number.isInteger(value.maxAttempts) ||
    (value.maxAttempts as number) < (value.attempt as number)
  ) {
    invalidItem("stream retry maxAttempts must be an integer at or above the attempt")
  }
  return {
    _tag: "ProviderStreamRetry",
    attempt: value.attempt as number,
    maxAttempts: value.maxAttempts as number,
    ...(typeof value.delayMs === "number" ? { delayMs: value.delayMs } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {})
  }
}

const checkToolCallDelta = (
  value: Record<string, unknown>
): Required<Omit<ToolCallStreamDelta, "_tag">> => {
  const delta = {
    index: value.index,
    tool_id: value.tool_id ?? null,
    name: value.name ?? null,
    arguments_delta: value.arguments_delta ?? null,
    done: value.done ?? false
  }
  if (!Number.isInteger(delta.index)) invalidItem("tool call delta index must be an integer")
  if (delta.tool_id !== null && typeof delta.tool_id !== "string")
    invalidItem("tool call delta tool_id must be a string or null")
  if (delta.name !== null && typeof delta.name !== "string")
    invalidItem("tool call delta name must be a string or null")
  if (delta.arguments_delta !== null && typeof delta.arguments_delta !== "string") {
    invalidItem("arguments_delta must be a string or null")
  }
  if (typeof delta.done !== "boolean") invalidItem("tool call delta done must be a boolean")
  return delta as Required<Omit<ToolCallStreamDelta, "_tag">>
}

const checkProviderToolCall = (raw: unknown): Required<ProviderToolCall> => {
  if (!isRecord(raw)) return invalidItem("provider tool call must be an object")
  const value: Record<string, unknown> = {
    ...raw,
    arguments: raw.arguments ?? {},
    result: raw.result ?? "",
    done: raw.done ?? true,
    loaded_tool_names: raw.loaded_tool_names ?? [],
    source_refs: raw.source_refs ?? []
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0)
    invalidItem("provider tool call id must not be empty")
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    invalidItem("provider tool call name must not be empty")
  }
  if (!isRecord(value.arguments)) invalidItem("provider tool call arguments must be an object")
  if (typeof value.result !== "string") invalidItem("provider tool call result must be a string")
  if (typeof value.done !== "boolean") invalidItem("provider tool call done must be a boolean")
  const loaded = value.loaded_tool_names
  if (
    !Array.isArray(loaded) ||
    loaded.some((name) => typeof name !== "string" || name.trim().length === 0)
  ) {
    invalidItem("loaded_tool_names must be an array of non-empty strings")
  }
  const sources = value.source_refs
  if (
    !Array.isArray(sources) ||
    sources.length > 50 ||
    sources.some((source) => !isRecord(source))
  ) {
    invalidItem("provider tool call source_refs must contain at most 50 objects")
  }
  return {
    id: value.id as string,
    name: value.name as string,
    arguments: value.arguments as Record<string, never>,
    result: value.result as string,
    done: value.done as boolean,
    loaded_tool_names: [...new Set(loaded as string[])],
    source_refs: sources as ReadonlyArray<Record<string, never>>
  }
}

const finishReasons = new Set<unknown>(Object.values(FinishReason))

const checkUniqueToolCallIds = (
  calls: ReadonlyArray<{ readonly id: string }>,
  execution: ToolExecution
): void => {
  const ids = calls.map((call) => call.id)
  if (new Set(ids).size !== ids.length) {
    invalidItem(`${execution} tool call ids must be unique`)
  }
}

const checkCompletion = (value: Record<string, unknown>): CompletionResponse => {
  if (typeof value.model !== "string") invalidItem("completion model must be a string")
  if (!isRecord(value.message)) invalidItem("completion must contain a message object")
  const usage: Record<string, unknown> = {
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...(isRecord(value.usage) ? value.usage : {})
  }
  for (const field of [
    "prompt_tokens",
    "completion_tokens",
    "cache_read_tokens",
    "cache_write_tokens"
  ]) {
    if (!Number.isInteger(usage[field])) invalidItem(`usage ${field} must be an integer`)
  }
  const cost = usage.cost
  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0))
    invalidItem("usage cost must be a finite non-negative number of dollars")
  const message: Record<string, unknown> = {
    content: null,
    tool_calls: null,
    reasoning_content: null,
    ...(value.message as Record<string, unknown>)
  }
  if (
    message.role !== ROLE.system &&
    message.role !== ROLE.user &&
    message.role !== ROLE.assistant &&
    message.role !== ROLE.tool
  )
    invalidItem("completion message role must be a chat role")
  if (message.content !== null && typeof message.content !== "string") {
    invalidItem("completion message content must be a string or null")
  }
  if (message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls))
      invalidItem("completion tool_calls must be an array or null")
    for (const call of message.tool_calls as unknown[]) {
      if (!isRecord(call)) invalidItem("tool_calls entries must be objects")
      const toolCall = call as Record<string, unknown>
      if (typeof toolCall.id !== "string" || toolCall.type !== TOOL_CALL_TYPE.function)
        invalidItem("invalid tool call shape")
      const fn = toolCall.function
      if (!isRecord(fn) || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
        invalidItem("invalid tool call function shape")
      }
    }
  }
  const runtimeCalls = message.tool_calls as ReadonlyArray<ToolCall> | null
  if (runtimeCalls !== null) checkUniqueToolCallIds(runtimeCalls, "runtime")
  if (message.reasoning_content !== null && typeof message.reasoning_content !== "string") {
    invalidItem("reasoning_content must be a string or null")
  }
  let providerCalls: ReadonlyArray<ProviderToolCall> | null | undefined
  if (message.provider_tool_calls !== undefined && message.provider_tool_calls !== null) {
    if (!Array.isArray(message.provider_tool_calls))
      invalidItem("provider_tool_calls must be an array or null")
    providerCalls = (message.provider_tool_calls as unknown[]).map(checkProviderToolCall)
    checkUniqueToolCallIds(providerCalls, "provider")
  } else {
    providerCalls = message.provider_tool_calls
  }
  let outputParts: ReadonlyArray<AssistantOutputPart> | null | undefined
  if (message.output_parts !== undefined && message.output_parts !== null) {
    if (
      !Array.isArray(message.output_parts) ||
      !message.output_parts.every(isAssistantOutputPart)
    ) {
      invalidItem("output_parts must contain valid ordered assistant parts")
    }
    outputParts = message.output_parts as ReadonlyArray<AssistantOutputPart>
    const runtimeIds = new Set(runtimeCalls?.map((call) => call.id) ?? [])
    const providerIds = new Set(providerCalls?.map((call) => call.id) ?? [])
    const toolCallParts = outputParts.filter(isToolCallPart)
    const references = (execution: ToolExecution) =>
      toolCallParts.flatMap((part) => (part.execution === execution ? [part.tool_call_id] : []))
    const runtimeReferences = references(TOOL_EXECUTION.runtime)
    const providerReferences = references(TOOL_EXECUTION.provider)
    for (const part of toolCallParts) {
      const ids = part.execution === TOOL_EXECUTION.runtime ? runtimeIds : providerIds
      if (!ids.has(part.tool_call_id)) {
        invalidItem(`output_parts references an unknown ${part.execution} tool call`)
      }
    }
    if (
      new Set(runtimeReferences).size !== runtimeReferences.length ||
      runtimeReferences.length !== runtimeIds.size
    )
      invalidItem("output_parts must reference every runtime tool call exactly once")
    if (
      new Set(providerReferences).size !== providerReferences.length ||
      providerReferences.length !== providerIds.size
    )
      invalidItem("output_parts must reference every provider tool call exactly once")
    const content = message.content as string | null
    const outputText = outputParts
      .filter(isTextPart)
      .map((part) => part.text)
      .join("")
    if (outputText !== (content ?? "")) {
      invalidItem("output_parts text must exactly cover the assistant content")
    }
    const reasoning = message.reasoning_content as string | null
    const reasoningParts = outputParts.filter(isReasoningPart).map((part) => part.text)
    const joinedReasoning = reasoningParts.join("")
    const separatedReasoning = reasoningParts.join("\n\n")
    if (joinedReasoning !== (reasoning ?? "") && separatedReasoning !== (reasoning ?? "")) {
      invalidItem("output_parts reasoning must exactly cover the assistant reasoning")
    }
  } else {
    outputParts = message.output_parts
  }
  if (message.provider_state !== undefined && !isRecord(message.provider_state)) {
    invalidItem("provider_state must be an object")
  }
  if (message.origin !== undefined && !isMessageOrigin(message.origin)) {
    invalidItem("origin must name a provider, api, model and requested_model")
  }
  if (value.finish_reason !== null && !finishReasons.has(value.finish_reason)) {
    invalidItem(`unknown finish_reason: ${String(value.finish_reason)}`)
  }
  return {
    _tag: "Completed",
    ...(value.continuation === true ? { continuation: true } : {}),
    message: {
      role: message.role as "assistant",
      content: message.content as string | null,
      tool_calls: runtimeCalls,
      reasoning_content: message.reasoning_content as string | null,
      ...(providerCalls === undefined ? {} : { provider_tool_calls: providerCalls }),
      ...(outputParts === undefined ? {} : { output_parts: outputParts }),
      ...(message.provider_state === undefined
        ? {}
        : { provider_state: message.provider_state as ProviderState }),
      ...(isMessageOrigin(message.origin) ? { origin: message.origin } : {})
    },
    finish_reason: value.finish_reason as CompletionResponse["finish_reason"],
    usage: usage as CompletionResponse["usage"],
    model: value.model as string
  }
}

const checkContentDelta = (value: Record<string, unknown>): string =>
  typeof value.content === "string"
    ? value.content
    : invalidItem(`${String(value._tag)} content must be a string`)

export const parseModelItem = (raw: unknown): ParsedStreamItem => {
  if (!isRecord(raw)) return invalidItem(`unsupported stream item: ${String(raw)}`)
  switch (raw._tag) {
    case MODEL_STREAM_ITEM_TAG.textDelta:
      return { _tag: MODEL_STREAM_ITEM_TAG.textDelta, content: checkContentDelta(raw) }
    case MODEL_STREAM_ITEM_TAG.reasoningDelta:
      return { _tag: MODEL_STREAM_ITEM_TAG.reasoningDelta, content: checkContentDelta(raw) }
    case MODEL_STREAM_ITEM_TAG.toolCallDelta:
      return { _tag: MODEL_STREAM_ITEM_TAG.toolCallDelta, delta: checkToolCallDelta(raw) }
    case MODEL_STREAM_ITEM_TAG.outputItemReady: {
      const response = checkCompletion({
        model: "",
        message: raw.message,
        finish_reason: "tool_calls",
        usage: { completion_tokens: 0 }
      })
      if (response.message.role !== ROLE.assistant)
        return invalidItem("completed output must be assistant content")
      for (const call of response.message.tool_calls ?? []) {
        if (call.id.length === 0 || call.function.name.length === 0)
          return invalidItem("ready tool call identity must not be empty")
        if (call.async !== undefined && typeof call.async !== "boolean")
          return invalidItem("ready tool call async must be a boolean")
      }
      return { _tag: MODEL_STREAM_ITEM_TAG.outputItemReady, message: response.message }
    }
    case MODEL_STREAM_ITEM_TAG.providerToolCall:
      return { _tag: MODEL_STREAM_ITEM_TAG.providerToolCall, call: checkProviderToolCall(raw.call) }
    case MODEL_STREAM_ITEM_TAG.providerStreamRetry:
      return checkStreamRetry(raw)
    case MODEL_STREAM_ITEM_TAG.completed:
      return checkCompletion(raw)
    default:
      return invalidItem(`unknown stream item tag: ${String(raw._tag)}`)
  }
}

export const validateCompletion = (response: CompletionResponse): CompletionResponse => {
  if (response.message.role !== ROLE.assistant) {
    throw new InvalidModelResponseError("model response role must be assistant")
  }
  if (response.finish_reason === null) {
    throw new InvalidModelResponseError("model response is missing its terminal reason")
  }
  if (response.finish_reason === FinishReason.CONTENT_FILTER) {
    throw new InvalidModelResponseError("the provider blocked the model response")
  }
  if (
    response.finish_reason !== FinishReason.STOP &&
    response.finish_reason !== FinishReason.TOOL_CALLS &&
    response.finish_reason !== FinishReason.LENGTH
  ) {
    throw new InvalidModelResponseError(
      `unsupported model terminal reason: ${String(response.finish_reason)}`
    )
  }
  return response
}
