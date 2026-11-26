import { ROLE } from "@arden-hq/std/message-vocabulary"
import { isRecord } from "@arden-hq/std/json"

import {
  ASSISTANT_OUTPUT_PART_TYPE,
  TOOL_EXECUTION,
  toolCallPart,
  type AssistantOutputPart,
  type JsonValue,
  type MessageOrigin,
  type ReadablePartType,
  type ToolCall
} from "../../contracts/messages.js"
import {
  FinishReason,
  type CompletionResponse,
  type ModelStreamItem,
  type Usage
} from "../../contracts/provider.js"
import type { ToolSearch } from "../../contracts/tools.js"
import {
  answerToolSearch,
  pendingToolSearch,
  reportedCost,
  SemanticResponseError,
  SSE_DONE,
  TOOL_SEARCH_TOOL_NAME,
  type SseEvent,
  type SseEventMapper
} from "../kit/index.js"
import { errorFrameFailure } from "./errors.js"
import { API } from "./request.js"
import { parseJsonText } from "@arden-hq/std/json-text"

const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const

const ANSWER_TEXT_FIELDS = ["content", "refusal"] as const

const CONCATENATED_DETAIL_FIELDS: ReadonlySet<string> = new Set(["text", "summary"])

const LEGACY_FUNCTION_CALL_FINISH = "function_call"

interface StreamedCall {
  readonly id: string
  readonly serverId: boolean
  name: string | undefined
  arguments: string
  announced: boolean
  search: boolean
}

type Part = ReadablePartType | number

export const makeChunkMapper = (options: {
  readonly requestedModel: string
  readonly providerId: string
  readonly label: string
  readonly generateId: () => string
  readonly toolSearch: ToolSearch | undefined
  readonly callsAllowed: boolean
}): SseEventMapper => {
  let text = ""
  let reasoning = ""
  let finish: string | undefined
  let usage: Usage | undefined
  let answeredBy: string | undefined
  const parts: Array<Part> = []
  const calls = new Map<number, StreamedCall>()
  const slotAtIndex = new Map<number, number>()
  const details = new Map<number, Record<string, JsonValue>>()
  let nextDetailIndex = 0

  const see = (part: Part): void => {
    if (!parts.includes(part)) parts.push(part)
  }

  const chunk = (value: unknown): ReadonlyArray<ModelStreamItem> => {
    if (!isRecord(value))
      throw new SemanticResponseError(`${options.label} returned an invalid stream chunk`)
    if (value.error !== undefined && value.error !== null)
      throw errorFrameFailure(options.label, value)
    if (typeof value.model === "string" && value.model.length > 0) answeredBy = value.model
    const first: unknown = Array.isArray(value.choices) ? value.choices[0] : undefined
    const choice = isRecord(first) ? first : undefined
    const reported = isRecord(value.usage) ? value.usage : choice?.usage
    if (isRecord(reported)) usage = usageOf(reported)
    if (choice === undefined) return []
    if (typeof choice.finish_reason === "string") finish = choice.finish_reason
    const delta = isRecord(choice.delta) ? choice.delta : undefined
    if (delta === undefined) return []
    const items: Array<ModelStreamItem> = []
    const reasoningDelta = REASONING_FIELDS.map((field) => delta[field]).find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0
    )
    if (reasoningDelta !== undefined) {
      reasoning += reasoningDelta
      see(ASSISTANT_OUTPUT_PART_TYPE.reasoning)
      items.push({ _tag: "ReasoningDelta", content: reasoningDelta })
    }
    for (const field of ANSWER_TEXT_FIELDS) {
      const piece = delta[field]
      if (typeof piece !== "string" || piece.length === 0) continue
      text += piece
      see(ASSISTANT_OUTPUT_PART_TYPE.text)
      items.push({ _tag: "TextDelta", content: piece })
    }
    if (Array.isArray(delta.tool_calls)) items.push(...delta.tool_calls.flatMap(callDelta))
    if (Array.isArray(delta.reasoning_details)) delta.reasoning_details.forEach(mergeDetail)
    return items
  }

  const callDelta = (value: unknown): ReadonlyArray<ModelStreamItem> => {
    if (!isRecord(value))
      throw new SemanticResponseError(`${options.label} returned an invalid tool call delta`)
    const fn = isRecord(value.function) ? value.function : {}
    const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined
    const index = callSlot(value.index, id)
    const name = typeof fn.name === "string" && fn.name.length > 0 ? fn.name : undefined
    const argumentsDelta = typeof fn.arguments === "string" ? fn.arguments : ""
    const call: StreamedCall = calls.get(index) ?? {
      id: id ?? options.generateId(),
      serverId: id !== undefined,
      name: undefined,
      arguments: "",
      announced: false,
      search: false
    }
    if (!calls.has(index)) {
      calls.set(index, call)
      see(index)
    }
    if (call.name === undefined) call.name = name
    call.arguments += argumentsDelta
    if (call.announced) {
      return call.search
        ? []
        : [{ _tag: "ToolCallDelta", index, arguments_delta: argumentsDelta, done: false }]
    }
    if (call.name === undefined) return []
    call.announced = true
    call.search = options.toolSearch !== undefined && call.name === TOOL_SEARCH_TOOL_NAME
    if (call.search)
      return [{ _tag: "ProviderToolCall", call: pendingToolSearch(call.id, call.arguments) }]
    return [
      {
        _tag: "ToolCallDelta",
        index,
        tool_id: call.id,
        name: call.name,
        arguments_delta: call.arguments,
        done: false
      }
    ]
  }

  const callSlot = (raw: unknown, id: string | undefined): number => {
    const serverIndex =
      typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined
    const byId =
      id === undefined ? undefined : [...calls].find(([, call]) => call.serverId && call.id === id)
    const open = serverIndex === undefined ? lastSlot() : slotAtIndex.get(serverIndex)
    const openCall = open === undefined ? undefined : calls.get(open)
    const continues =
      openCall !== undefined && (id === undefined || !openCall.serverId || openCall.id === id)
    const slot = byId?.[0] ?? (continues ? open : undefined) ?? calls.size
    if (serverIndex !== undefined) slotAtIndex.set(serverIndex, slot)
    return slot
  }

  const lastSlot = (): number | undefined => (calls.size === 0 ? undefined : calls.size - 1)

  const mergeDetail = (value: unknown): void => {
    if (!isRecord(value))
      throw new SemanticResponseError(`${options.label} returned an invalid reasoning detail`)
    const index =
      typeof value.index === "number" && Number.isSafeInteger(value.index)
        ? value.index
        : nextDetailIndex
    nextDetailIndex = Math.max(nextDetailIndex, index + 1)
    const merged = details.get(index) ?? {}
    for (const [key, fragment] of Object.entries(value)) {
      if (!isJsonValue(fragment)) continue
      const previous = merged[key]
      merged[key] =
        CONCATENATED_DETAIL_FIELDS.has(key) &&
        typeof previous === "string" &&
        typeof fragment === "string"
          ? previous + fragment
          : fragment
    }
    details.set(index, merged)
  }

  const terminal = (): ReadonlyArray<ModelStreamItem> => {
    const reason = finishReason(finish ?? FinishReason.STOP, options.label)
    const kept = [...calls].flatMap(([index, call]) => {
      const cutOffByOutputLimit =
        reason === FinishReason.LENGTH &&
        (call.name === undefined || !isCompleteJson(call.arguments))
      if (cutOffByOutputLimit) return []
      if (call.name === undefined)
        throw new SemanticResponseError(`${options.label} returned a tool call without a name`)
      return [
        { index, id: call.id, name: call.name, arguments: call.arguments, search: call.search }
      ]
    })
    const refused = options.callsAllowed ? undefined : kept[0]
    if (refused !== undefined)
      throw new SemanticResponseError(
        `${options.label} model called ${refused.name} although the request allowed no tool call`
      )
    const runtime = kept.filter((call) => !call.search)
    const toolCalls = runtime.map((call): ToolCall => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments }
    }))
    const searches = kept
      .filter((call) => call.search)
      .map((call) => answerToolSearch(call.id, call.arguments, options.toolSearch).call)
    const keptParts = new Map(
      kept.map((call): [number, AssistantOutputPart] => [
        call.index,
        toolCallPart(call.id, call.search ? TOOL_EXECUTION.provider : TOOL_EXECUTION.runtime)
      ])
    )
    const origin: MessageOrigin = {
      provider: options.providerId,
      api: API,
      model: answeredBy ?? options.requestedModel,
      requested_model: options.requestedModel
    }
    const replay = [...details].sort(([left], [right]) => left - right).map(([, detail]) => detail)
    const completed: CompletionResponse = {
      _tag: "Completed",
      message: {
        role: ROLE.assistant,
        content: text.length === 0 ? null : text,
        tool_calls: toolCalls.length === 0 ? null : toolCalls,
        reasoning_content: reasoning.length === 0 ? null : reasoning,
        output_parts: parts.flatMap((part): ReadonlyArray<AssistantOutputPart> => {
          if (part === ASSISTANT_OUTPUT_PART_TYPE.reasoning)
            return [{ type: ASSISTANT_OUTPUT_PART_TYPE.reasoning, text: reasoning }]
          if (part === ASSISTANT_OUTPUT_PART_TYPE.text)
            return [{ type: ASSISTANT_OUTPUT_PART_TYPE.text, text }]
          const kept = keptParts.get(part)
          return kept === undefined ? [] : [kept]
        }),
        ...(searches.length === 0 ? {} : { provider_tool_calls: searches }),
        ...(replay.length === 0
          ? {}
          : { provider_state: { [API]: { reasoning_details: replay } } }),
        origin
      },
      ...(searches.length === 0 ? {} : { continuation: true }),
      finish_reason: runtimeFinish(reason, toolCalls.length > 0),
      usage: usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost: undefined
      },
      model: options.requestedModel
    }
    return [
      ...runtime.map((call): ModelStreamItem => ({
        _tag: "ToolCallDelta",
        index: call.index,
        arguments_delta: null,
        done: true
      })),
      completed
    ]
  }

  return {
    event: (event: SseEvent) => {
      const data = event.data.trim()
      if (data === SSE_DONE) return terminal()
      if (data.length === 0) return []
      let decoded: unknown
      try {
        decoded = parseJsonText(data)
      } catch {
        throw new SemanticResponseError(`${options.label} returned an invalid SSE event`)
      }
      return chunk(decoded)
    },
    end: () => (finish === undefined ? [] : terminal())
  }
}

const runtimeFinish = (reason: FinishReason, hasRuntimeCalls: boolean): FinishReason => {
  if (reason === FinishReason.STOP && hasRuntimeCalls) return FinishReason.TOOL_CALLS
  if (reason === FinishReason.TOOL_CALLS && !hasRuntimeCalls) return FinishReason.STOP
  return reason
}

const finishReason = (raw: string, label: string): FinishReason => {
  switch (raw) {
    case FinishReason.STOP:
    case FinishReason.LENGTH:
    case FinishReason.TOOL_CALLS:
    case FinishReason.CONTENT_FILTER:
      return raw
    case LEGACY_FUNCTION_CALL_FINISH:
      return FinishReason.TOOL_CALLS
    default:
      throw new SemanticResponseError(
        `${label} finished with an unknown reason: ${raw.slice(0, 128)}`
      )
  }
}

const usageOf = (raw: Readonly<Record<string, unknown>>): Usage => {
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {}
  const cacheRead = tokens(details.cached_tokens)
  const cacheWrite = tokens(details.cache_write_tokens)
  return {
    prompt_tokens: Math.max(0, tokens(raw.prompt_tokens) - cacheRead - cacheWrite),
    completion_tokens: tokens(raw.completion_tokens),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cost: reportedCost(raw)
  }
}

const tokens = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0

const isCompleteJson = (text: string): boolean => {
  try {
    parseJsonText(text)
    return true
  } catch {
    return false
  }
}

const isJsonValue = (value: unknown): value is JsonValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  (Array.isArray(value) && value.every(isJsonValue)) ||
  (isRecord(value) && Object.values(value).every(isJsonValue))
