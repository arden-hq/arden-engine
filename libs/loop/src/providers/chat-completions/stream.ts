import { isRecord } from "@arden-hq/std/json"

import type {
  AssistantOutputPart,
  JsonValue,
  MessageOrigin,
  ToolCall
} from "../../contracts/messages.js"
import type {
  CompletionResponse,
  FinishReason,
  ModelStreamItem,
  Usage
} from "../../contracts/provider.js"
import { SemanticResponseError, type SseEvent, type SseEventMapper } from "../kit/index.js"
import { errorFrameFailure } from "./errors.js"
import { API } from "./request.js"

/**
 * The fields servers stream reasoning text in: llama.cpp `reasoning_content`,
 * OpenRouter `reasoning`, some gateways `reasoning_text`. A chunk may repeat
 * the same text in several; the first non-empty one is the delta.
 */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const

interface StreamedCall {
  readonly id: string
  name: string | undefined
  arguments: string
}

/** A part of the answer, by first appearance: the reasoning, the text, or call `index`. */
type Part = "reasoning" | "text" | number

/**
 * Maps one Chat Completions SSE response onto stream items. The stream ends
 * at `[DONE]`, or when the body closes after a `finish_reason` (the usage
 * chunk follows the finish chunk, so the finish alone is not the end).
 * Only `Completed` carries the answer: no `OutputItemReady`, so the loop
 * runs the calls as one batch after the response (the documented behaviour
 * for a provider that emits only `Completed`).
 */
export const makeChunkMapper = (options: {
  readonly requestedModel: string
  readonly providerId: string
  readonly label: string
  readonly generateId: () => string
}): SseEventMapper => {
  let text = ""
  let reasoning = ""
  let finish: string | undefined
  let usage: Usage | undefined
  let answeredBy: string | undefined
  const parts: Array<Part> = []
  const calls = new Map<number, StreamedCall>()
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
    // Usage rides on its own chunk after the finish; a few servers put it on the choice.
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
      see("reasoning")
      items.push({ _tag: "ReasoningDelta", content: reasoningDelta })
    }
    // OpenAI streams a refusal in its own field; it is the answer's text, as
    // the Responses adapter treats `response.refusal.delta`.
    for (const field of ["content", "refusal"] as const) {
      const piece = delta[field]
      if (typeof piece !== "string" || piece.length === 0) continue
      text += piece
      see("text")
      items.push({ _tag: "TextDelta", content: piece })
    }
    if (Array.isArray(delta.tool_calls)) items.push(...delta.tool_calls.flatMap(callDelta))
    if (Array.isArray(delta.reasoning_details)) delta.reasoning_details.forEach(mergeDetail)
    return items
  }

  const callDelta = (value: unknown): ReadonlyArray<ModelStreamItem> => {
    if (!isRecord(value)) return []
    const fn = isRecord(value.function) ? value.function : {}
    const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined
    const index = callIndex(value.index, id)
    const name = typeof fn.name === "string" && fn.name.length > 0 ? fn.name : undefined
    const argumentsDelta = typeof fn.arguments === "string" ? fn.arguments : ""
    const known = calls.get(index)
    if (known === undefined) {
      // A server that streams no id gets one here; the first id seen stays,
      // as the loop already announced the call under it.
      const call: StreamedCall = { id: id ?? options.generateId(), name, arguments: argumentsDelta }
      calls.set(index, call)
      see(index)
      return [
        {
          _tag: "ToolCallDelta",
          index,
          tool_id: call.id,
          ...(name === undefined ? {} : { name }),
          arguments_delta: argumentsDelta,
          done: false
        }
      ]
    }
    const named = known.name === undefined && name !== undefined
    if (named) known.name = name
    known.arguments += argumentsDelta
    return [
      {
        _tag: "ToolCallDelta",
        index,
        ...(named ? { name } : {}),
        arguments_delta: argumentsDelta,
        done: false
      }
    ]
  }

  const callIndex = (raw: unknown, id: string | undefined): number => {
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw
    const byId = [...calls].find(([, call]) => call.id === id)
    if (byId !== undefined) return byId[0]
    return calls.size === 0 ? 0 : Math.max(...calls.keys()) + 1
  }

  // OpenRouter streams `reasoning_details` in fragments keyed by `index`:
  // `text` and `summary` fragments append, every other key overwrites (prime
  // `handle_chunk`). The merged entries are opaque replay state.
  const mergeDetail = (value: unknown): void => {
    if (!isRecord(value)) return
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
        (key === "text" || key === "summary") &&
        typeof previous === "string" &&
        typeof fragment === "string"
          ? previous + fragment
          : fragment
    }
    details.set(index, merged)
  }

  const terminal = (): ReadonlyArray<ModelStreamItem> => {
    const reason = finishReason(finish ?? "stop", options.label)
    const kept = [...calls].flatMap(([index, call]) => {
      if (call.name === undefined)
        throw new SemanticResponseError(`${options.label} returned a tool call without a name`)
      // A call the output limit cut off has arguments that are not JSON yet;
      // it never runs. Every other finish hands the arguments on as written:
      // the loop answers malformed ones with a correction the model can act on.
      return reason === "length" && !isCompleteJson(call.arguments)
        ? []
        : [{ index, id: call.id, name: call.name, arguments: call.arguments }]
    })
    const toolCalls = kept.map((call): ToolCall => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments }
    }))
    const keptIds = new Map(kept.map((call) => [call.index, call.id]))
    const origin: MessageOrigin = {
      provider: options.providerId,
      api: API,
      model: answeredBy ?? options.requestedModel
    }
    const replay = [...details].sort(([left], [right]) => left - right).map(([, detail]) => detail)
    const completed: CompletionResponse = {
      _tag: "Completed",
      message: {
        role: "assistant",
        content: text.length === 0 ? null : text,
        tool_calls: toolCalls.length === 0 ? null : toolCalls,
        reasoning_content: reasoning.length === 0 ? null : reasoning,
        output_parts: parts.flatMap((part): ReadonlyArray<AssistantOutputPart> => {
          if (part === "reasoning") return [{ type: "reasoning", text: reasoning }]
          if (part === "text") return [{ type: "text", text }]
          const id = keptIds.get(part)
          return id === undefined
            ? []
            : [{ type: "tool_call", tool_call_id: id, execution: "runtime" }]
        }),
        ...(replay.length === 0
          ? {}
          : { provider_state: { [API]: { reasoning_details: replay } } }),
        origin
      },
      finish_reason: reason === "stop" && toolCalls.length > 0 ? "tool_calls" : reason,
      usage: usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0
      },
      model: options.requestedModel
    }
    return [
      ...kept.map((call): ModelStreamItem => ({
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
      if (data === "[DONE]") return terminal()
      if (data.length === 0) return []
      let decoded: unknown
      try {
        decoded = JSON.parse(data)
      } catch {
        throw new SemanticResponseError(`${options.label} returned an invalid SSE event`)
      }
      return chunk(decoded)
    },
    end: () => (finish === undefined ? [] : terminal())
  }
}

const finishReason = (raw: string, label: string): FinishReason => {
  switch (raw) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return raw
    case "function_call":
      return "tool_calls"
    default:
      throw new SemanticResponseError(
        `${label} finished with an unknown reason: ${raw.slice(0, 128)}`
      )
  }
}

/**
 * Usage without double counting: `prompt_tokens` includes the cached and the
 * cache-written tokens, so both come off it. Some servers (seen on
 * OpenRouter) count this request's cache writes inside `cached_tokens` as
 * well; with both reported, writes come off the cached count (prime
 * `parse_chunk_usage`).
 */
const usageOf = (raw: Readonly<Record<string, unknown>>): Usage => {
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {}
  const prompt = tokens(raw.prompt_tokens)
  const reportedCached = tokens(details.cached_tokens)
  const cacheWrite = tokens(details.cache_write_tokens)
  const cacheRead = cacheWrite > 0 ? Math.max(0, reportedCached - cacheWrite) : reportedCached
  return {
    prompt_tokens: Math.max(0, prompt - cacheRead - cacheWrite),
    completion_tokens: tokens(raw.completion_tokens),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite
  }
}

const tokens = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0

const isCompleteJson = (text: string): boolean => {
  try {
    JSON.parse(text)
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
