import { InvalidModelResponseError, ModelProviderError, ProtocolContractError } from "../errors.js"
import { INTERACTION_OUTCOMES } from "../contracts/messages.js"
import type {
  AssistantOutputPart,
  ChatMessage,
  ContentBlock,
  ProviderState,
  ProviderToolCall,
  ToolCall
} from "../contracts/messages.js"
import type { ToolResult } from "../contracts/tools.js"
import {
  FinishReason,
  type CompletionResponse,
  type ProviderStreamRetry,
  type OutputItemReady,
  type ToolCallStreamDelta
} from "../contracts/provider.js"
import { isRecord } from "@arden-hq/std/json"

// The explicit annotation lets fail's never-return participate in
// control-flow narrowing at call sites.
const fail: (subject: string, detail: string) => never = (subject, detail) => {
  throw new ProtocolContractError(subject, new TypeError(detail))
}

const checkMessageId = (message: Record<string, unknown>): void => {
  if (
    "message_id" in message &&
    (typeof message.message_id !== "string" || message.message_id.length === 0)
  ) {
    fail("messages", "message_id must be a non-empty string")
  }
}

const isBlockArray = (value: unknown): boolean => Array.isArray(value) && value.every(isRecord)

const checkInteraction = (value: unknown): void => {
  if (!isRecord(value)) fail("messages", "interaction must be an object")
  const actor = (candidate: unknown): boolean =>
    isRecord(candidate) &&
    ["agent", "workflow", "tool", "harness", "user"].includes(String(candidate.type)) &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0
  if (!actor(value.from) || !actor(value.to) || typeof value.content !== "string") {
    fail("messages", "interaction needs valid actors and content")
  }
  if (
    !["message", "assignment", "completion", "event", "instruction"].includes(String(value.kind))
  ) {
    fail("messages", "interaction kind is invalid")
  }
  if (
    value.kind === "completion" &&
    !INTERACTION_OUTCOMES.some((outcome) => outcome === value.outcome)
  ) {
    fail("messages", "completion interaction outcome is invalid")
  }
  if (
    value.causedBy !== undefined &&
    (!isRecord(value.causedBy) ||
      !["message", "run", "tool_call", "workflow"].includes(String(value.causedBy.type)) ||
      typeof value.causedBy.id !== "string" ||
      value.causedBy.id.length === 0)
  ) {
    fail("messages", "interaction reference is invalid")
  }
}

const checkReplyContext = (value: unknown): void => {
  if (
    !isRecord(value) ||
    typeof value.messageId !== "string" ||
    value.messageId.length === 0 ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.content !== "string"
  ) {
    fail("messages", "replyTo needs a message id, role, and content")
  }
}

const checkToolCall = (value: unknown): void => {
  if (!isRecord(value)) fail("messages", "tool_calls entries must be objects")
  const call = value
  if (typeof call.id !== "string") fail("messages", "tool call id must be a string")
  if (call.type !== "function") fail("messages", 'tool call type must be "function"')
  const fn = call.function
  if (!isRecord(fn) || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
    fail("messages", "tool call function must have string name and arguments")
  }
}

const isAssistantOutputPart = (value: unknown): value is AssistantOutputPart => {
  if (!isRecord(value)) return false
  if (value.type === "reasoning") {
    return typeof value.text === "string" && value.text.length > 0
  }
  if (value.type === "text") {
    return (
      typeof value.text === "string" &&
      value.text.length > 0 &&
      (value.phase === undefined || value.phase === "commentary" || value.phase === "final_answer")
    )
  }
  return (
    value.type === "tool_call" &&
    typeof value.tool_call_id === "string" &&
    value.tool_call_id.length > 0 &&
    (value.execution === "runtime" || value.execution === "provider")
  )
}

const checkMessage = (value: unknown): void => {
  if (!isRecord(value)) fail("messages", "each message must be an object")
  const message = value
  checkMessageId(message)
  switch (message.role) {
    case "system":
    case "developer": {
      if (typeof message.content !== "string" && !isBlockArray(message.content)) {
        fail("messages", `${message.role} content must be a string or content-block array`)
      }
      return
    }
    case "user": {
      if ("interaction" in message && "replyTo" in message) {
        fail("messages", "user messages cannot be both interactions and replies")
      }
      if ("interaction" in message) checkInteraction(message.interaction)
      if ("replyTo" in message) checkReplyContext(message.replyTo)
      if (
        "content" in message &&
        message.content !== null &&
        typeof message.content !== "string" &&
        !isBlockArray(message.content)
      ) {
        fail("messages", "user content must be a string, null, or content-block array")
      }
      return
    }
    case "assistant": {
      if (
        "content" in message &&
        message.content !== null &&
        typeof message.content !== "string" &&
        !isBlockArray(message.content)
      ) {
        fail("messages", "assistant content must be a string, null, or content-block array")
      }
      if ("tool_calls" in message) {
        if (!Array.isArray(message.tool_calls)) fail("messages", "tool_calls must be an array")
        for (const call of message.tool_calls as unknown[]) checkToolCall(call)
      }
      if (
        "reasoning_content" in message &&
        message.reasoning_content !== null &&
        typeof message.reasoning_content !== "string"
      ) {
        fail("messages", "reasoning_content must be a string or null")
      }
      if (
        "output_parts" in message &&
        (!Array.isArray(message.output_parts) || !message.output_parts.every(isAssistantOutputPart))
      ) {
        fail("messages", "output_parts must contain valid ordered assistant parts")
      }
      return
    }
    case "tool": {
      if (typeof message.tool_call_id !== "string")
        fail("messages", "tool message needs a tool_call_id")
      if (typeof message.content !== "string")
        fail("messages", "tool message content must be a string")
      return
    }
    default:
      fail("messages", `unknown message role: ${String(message.role)}`)
  }
}

/**
 * Structural validation of one chat message; throws `ProtocolContractError`
 * whose cause names the broken field. Extension fields ride through untouched.
 */
export const decodeMessage = (value: unknown): ChatMessage => {
  checkMessage(value)
  return value as ChatMessage
}

/** Structural history validation. Extension fields ride through untouched. */
export const decodeMessages = (value: unknown): ReadonlyArray<ChatMessage> => {
  if (!Array.isArray(value)) fail("messages", "messages must be an array")
  return (value as unknown[]).map(decodeMessage)
}

export type ParsedStreamItem =
  | { readonly _tag: "TextDelta"; readonly content: string }
  | { readonly _tag: "ReasoningDelta"; readonly content: string }
  | { readonly _tag: "ToolCallDelta"; readonly delta: Required<Omit<ToolCallStreamDelta, "_tag">> }
  | { readonly _tag: "ProviderToolCall"; readonly call: Required<ProviderToolCall> }
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
  execution: "runtime" | "provider"
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
  const message: Record<string, unknown> = {
    content: null,
    tool_calls: null,
    reasoning_content: null,
    ...(value.message as Record<string, unknown>)
  }
  if (
    message.role !== "system" &&
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "tool"
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
      if (typeof toolCall.id !== "string" || toolCall.type !== "function")
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
    const runtimeReferences = outputParts.flatMap((part) =>
      part.type === "tool_call" && part.execution === "runtime" ? [part.tool_call_id] : []
    )
    const providerReferences = outputParts.flatMap((part) =>
      part.type === "tool_call" && part.execution === "provider" ? [part.tool_call_id] : []
    )
    for (const part of outputParts) {
      if (part.type !== "tool_call") continue
      const ids = part.execution === "runtime" ? runtimeIds : providerIds
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
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
    if (outputText !== (content ?? "")) {
      invalidItem("output_parts text must exactly cover the assistant content")
    }
    const reasoning = message.reasoning_content as string | null
    const reasoningParts = outputParts.flatMap((part) =>
      part.type === "reasoning" ? [part.text] : []
    )
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
        : { provider_state: message.provider_state as ProviderState })
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

/** Validate one provider stream item by its tag; malformed items become ModelProviderError. */
export const parseModelItem = (raw: unknown): ParsedStreamItem => {
  if (!isRecord(raw)) return invalidItem(`unsupported stream item: ${String(raw)}`)
  switch (raw._tag) {
    case "TextDelta":
      return { _tag: "TextDelta", content: checkContentDelta(raw) }
    case "ReasoningDelta":
      return { _tag: "ReasoningDelta", content: checkContentDelta(raw) }
    case "ToolCallDelta":
      return { _tag: "ToolCallDelta", delta: checkToolCallDelta(raw) }
    case "OutputItemReady": {
      const response = checkCompletion({
        model: "",
        message: raw.message,
        finish_reason: "tool_calls",
        usage: { completion_tokens: 0 }
      })
      if (response.message.role !== "assistant")
        return invalidItem("completed output must be assistant content")
      for (const call of response.message.tool_calls ?? []) {
        if (call.id.length === 0 || call.function.name.length === 0)
          return invalidItem("ready tool call identity must not be empty")
        if (call.async !== undefined && typeof call.async !== "boolean")
          return invalidItem("ready tool call async must be a boolean")
      }
      return { _tag: "OutputItemReady", message: response.message }
    }
    case "ProviderToolCall":
      return { _tag: "ProviderToolCall", call: checkProviderToolCall(raw.call) }
    case "ProviderStreamRetry":
      return checkStreamRetry(raw)
    case "Completed":
      return checkCompletion(raw)
    default:
      return invalidItem(`unknown stream item tag: ${String(raw._tag)}`)
  }
}

/** Terminal-response validation. Ported 1:1 from the previous runtime. */
export const validateCompletion = (response: CompletionResponse): CompletionResponse => {
  if (response.message.role !== "assistant") {
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

/** Fill ToolResult defaults; throws TypeError on a structurally invalid value. */
export const normalizeToolResult = (value: unknown): Required<ToolResult> => {
  if (!isRecord(value)) throw new TypeError("tool result must be an object")
  const record = value
  if (typeof record.content !== "string")
    throw new TypeError("tool result content must be a string")
  if (typeof record.preview !== "string")
    throw new TypeError("tool result preview must be a string")
  const isError = record.is_error ?? false
  if (typeof isError !== "boolean") throw new TypeError("tool result is_error must be a boolean")
  const retryable = record.retryable ?? null
  if (retryable !== null && typeof retryable !== "boolean") {
    throw new TypeError("tool result retryable must be a boolean or null")
  }
  const data = record.data ?? null
  if (data !== null && !isRecord(data))
    throw new TypeError("tool result data must be an object or null")
  const extras = record.message_extras ?? {}
  if (!isRecord(extras)) throw new TypeError("tool result message_extras must be an object")
  const host = record.host ?? {}
  if (!isRecord(host)) throw new TypeError("tool result host must be an object")
  const modelContent = record.model_content ?? []
  if (!Array.isArray(modelContent) || !modelContent.every(isRecord)) {
    throw new TypeError("tool result model_content must be an array of content blocks")
  }
  return {
    content: record.content,
    preview: record.preview,
    is_error: isError,
    retryable,
    data: data as Required<ToolResult>["data"],
    message_extras: extras,
    host,
    model_content: modelContent as unknown as ReadonlyArray<ContentBlock>
  }
}
