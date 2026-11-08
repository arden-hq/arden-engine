import type {
  AssistantMessage,
  AssistantOutputPart,
  JsonObject,
  ProviderToolCall,
  ToolCall
} from "../contracts/messages.js"
import type { CompletionResponse } from "../contracts/provider.js"
import type { ToolDisplayTitle, ToolMeta } from "../contracts/tools.js"
import type { AgentEvent } from "../contracts/events.js"
import { sanitizeToolDisplayTitle, splitToolArguments } from "../tools/display-title.js"
import { isRecord } from "@arden-hq/std/json"

export interface ToolStartSnapshot {
  readonly timestamp: number
  readonly parentId: string | null
  readonly persisted: JsonObject
}

export type ToolStartEvent = Extract<
  AgentEvent,
  { readonly _tag: "ToolInputStarted" | "ToolStarted" }
>

export const startKey = (execution: "runtime" | "provider", toolId: string): string =>
  `${execution}:${toolId}`

const persistedStart = (snapshot: ToolStartSnapshot | undefined) =>
  snapshot === undefined
    ? {}
    : { started_at: snapshot.timestamp, parent_id: snapshot.parentId, ...snapshot.persisted }

const providerHost = (
  call: ProviderToolCall,
  metas: ReadonlyMap<string, ToolMeta>
): Readonly<Record<string, unknown>> => ({
  ...(metas.get(call.name)?.host ?? {}),
  ...(call.source_refs === undefined ? {} : { source_refs: call.source_refs })
})

export const providerStarted = (
  call: ProviderToolCall,
  metas: ReadonlyMap<string, ToolMeta>
): ToolStartEvent => ({
  _tag: "ToolStarted",
  depth: 0,
  parent_id: null,
  tool_id: call.id,
  name: call.name,
  args: { ...(call.arguments ?? {}) },
  host: { ...providerHost(call, metas) },
  execution: "provider"
})

export const providerCompleted = (
  call: ProviderToolCall,
  metas: ReadonlyMap<string, ToolMeta>,
  durationMs: number
): AgentEvent => ({
  _tag: "ToolCompleted",
  depth: 0,
  parent_id: null,
  tool_id: call.id,
  name: call.name,
  result: call.result ?? "",
  preview: call.result ?? "",
  duration_ms: durationMs,
  is_error: false,
  data: { provider_executed: true },
  retryable: null,
  message_extras: {},
  host: { ...providerHost(call, metas) },
  model_content: [],
  ends_turn: false,
  execution: "provider"
})

const providerCallRecord = (call: ProviderToolCall, snapshot: ToolStartSnapshot | undefined) => ({
  id: call.id,
  name: call.name,
  arguments: { ...(call.arguments ?? {}) },
  ...(call.result === undefined ? {} : { result: call.result }),
  ...(call.done === undefined ? {} : { done: call.done }),
  loaded_tool_names: [...(call.loaded_tool_names ?? [])],
  ...(call.source_refs === undefined
    ? {}
    : { source_refs: call.source_refs.map((source) => ({ ...source })) }),
  ...persistedStart(snapshot)
})

const tryProjectArguments = (
  rawArguments: string,
  rawDisplayTitle: ToolCall["display_title"],
  displayTitleArgument: ToolDisplayTitle | undefined
):
  | { args: string; displayTitle: ReturnType<typeof splitToolArguments>["displayTitle"] }
  | undefined => {
  try {
    const decoded: unknown = JSON.parse(rawArguments)
    if (!isRecord(decoded)) return undefined
    const projected = splitToolArguments(decoded, rawDisplayTitle, displayTitleArgument)
    return { args: JSON.stringify(projected.args), displayTitle: projected.displayTitle }
  } catch {
    return undefined
  }
}

export const persistedToolCall = (
  call: ToolCall,
  snapshot: ToolStartSnapshot | undefined,
  displayTitleArgument: ToolDisplayTitle | undefined
): ToolCall => {
  const { display_title: rawDisplayTitle, function: rawFunction, ...metadata } = call
  const sanitizedTitle =
    displayTitleArgument === undefined
      ? undefined
      : sanitizeToolDisplayTitle(rawDisplayTitle, displayTitleArgument)
  const { args: callArguments, displayTitle } = tryProjectArguments(
    rawFunction.arguments,
    rawDisplayTitle,
    displayTitleArgument
  ) ?? {
    args: rawFunction.arguments,
    displayTitle: sanitizedTitle
  }
  return {
    ...metadata,
    function: { ...rawFunction, arguments: callArguments },
    ...(displayTitle === undefined ? {} : { display_title: displayTitle }),
    ...persistedStart(snapshot)
  }
}

export const fallbackOutputParts = (
  response: CompletionResponse,
  streamed: ReadonlyArray<AssistantOutputPart>
): ReadonlyArray<AssistantOutputPart> => {
  const message = response.message
  let parts = [...streamed]
  const reasoning = message.reasoning_content ?? ""
  const reasoningIndexes = parts.flatMap((part, index) =>
    part.type === "reasoning" ? [index] : []
  )
  const onlyReasoningIndex = reasoningIndexes.length === 1 ? reasoningIndexes[0] : undefined
  if (reasoning.length > 0 && reasoningIndexes.length === 0) {
    parts.unshift({ type: "reasoning", text: reasoning })
  } else if (reasoning.length > 0 && onlyReasoningIndex !== undefined) {
    parts[onlyReasoningIndex] = { type: "reasoning", text: reasoning }
  }
  const content = message.content ?? ""
  const textIndexes = parts.flatMap((part, index) => (part.type === "text" ? [index] : []))
  const onlyTextIndex = textIndexes.length === 1 ? textIndexes[0] : undefined
  const finalIndex = textIndexes.at(-1)
  if (content.length > 0 && textIndexes.length === 0) {
    parts.push({ type: "text", text: content })
  } else if (content.length > 0 && onlyTextIndex !== undefined) {
    parts[onlyTextIndex] = { type: "text", text: content }
  } else if (content.length > 0 && finalIndex !== undefined) {
    const prefix = textIndexes
      .slice(0, -1)
      .map((index) => {
        const part = parts[index]
        return part?.type === "text" ? part.text : ""
      })
      .join("")
    const finalPart = parts[finalIndex]
    const suffix = content.startsWith(prefix) ? content.slice(prefix.length) : ""
    if (finalPart?.type === "text" && suffix.length > 0) {
      parts[finalIndex] = { ...finalPart, text: suffix }
    }
  }
  const textJoin = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
  if (textJoin !== content) {
    const firstTextIndex = parts.findIndex((part) => part.type === "text")
    const phase = parts.some((part) => part.type === "text" && part.phase === "final_answer")
      ? ("final_answer" as const)
      : parts.flatMap((part) =>
          part.type === "text" && part.phase !== undefined ? [part.phase] : []
        )[0]
    const merged: AssistantOutputPart = {
      type: "text",
      text: content,
      ...(phase === undefined ? {} : { phase })
    }
    parts = parts.flatMap((part, index): ReadonlyArray<AssistantOutputPart> => {
      if (part.type !== "text") return [part]
      return index === firstTextIndex && content.length > 0 ? [merged] : []
    })
  }
  const referenced = new Set(
    parts.flatMap((part) =>
      part.type === "tool_call" ? [`${part.execution}:${part.tool_call_id}`] : []
    )
  )
  parts.push(
    ...(message.provider_tool_calls ?? [])
      .filter((call) => !referenced.has(`provider:${call.id}`))
      .map((call) => ({
        type: "tool_call" as const,
        tool_call_id: call.id,
        execution: "provider" as const
      })),
    ...(message.tool_calls ?? [])
      .filter((call) => !referenced.has(`runtime:${call.id}`))
      .map((call) => ({
        type: "tool_call" as const,
        tool_call_id: call.id,
        execution: "runtime" as const
      }))
  )
  return parts
}

export const assistantMessage = (
  response: CompletionResponse,
  messageId: string,
  streamedTextId: string | null,
  outputParts: ReadonlyArray<AssistantOutputPart>,
  starts: ReadonlyMap<string, ToolStartSnapshot>,
  displayTitle: ToolDisplayTitle | undefined
): AssistantMessage => {
  const message = response.message
  return {
    message_id: messageId,
    role: "assistant",
    content: message.content ?? "",
    ...(message.tool_calls === null || message.tool_calls.length === 0
      ? {}
      : {
          tool_calls: message.tool_calls.map((call) =>
            persistedToolCall(call, starts.get(startKey("runtime", call.id)), displayTitle)
          )
        }),
    ...(message.reasoning_content === null ? {} : { reasoning_content: message.reasoning_content }),
    ...(message.provider_tool_calls === null ||
    message.provider_tool_calls === undefined ||
    message.provider_tool_calls.length === 0
      ? {}
      : {
          provider_tool_calls: message.provider_tool_calls.map((call) =>
            providerCallRecord(call, starts.get(startKey("provider", call.id)))
          )
        }),
    output_parts: [...outputParts],
    ...(message.provider_state === undefined ? {} : { provider_state: message.provider_state }),
    ...(streamedTextId === null ? {} : { client_id: streamedTextId })
  }
}
