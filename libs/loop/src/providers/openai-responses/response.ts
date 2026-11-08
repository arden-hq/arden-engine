import { clipLine } from "@arden-hq/std/text"
import type { AssistantOutputPart, JsonValue, ToolCall } from "../../contracts/messages.js"
import type { CompletionResponse, FinishReason, ModelStreamItem } from "../../contracts/provider.js"
import type { ToolSearch } from "../../contracts/tools.js"
import { OpenAiCitationFilter, stripOpenAiCitations } from "./citations.js"
import { RetryableProviderError, SemanticResponseError } from "../kit/index.js"
import { MAX_STATUS_DETAIL_CHARS, TERMINAL_RESPONSE_CODES } from "./errors.js"
import {
  asRecord,
  messageItemText,
  normalizeOutputItem,
  PROVIDER_STATE_KEY,
  stringValue,
  SYNTHETIC_OUTPUT_ID_PREFIX,
  WEB_SEARCH_TOOL_NAME,
  type OutputItem,
  type RawResponseEvent,
  type ReasoningOutputItem,
  type ResponseShape,
  type ResponseUsage,
  type ToolSearchOutputInputItem
} from "./items.js"
import { answerToolSearches, pendingToolSearchCall } from "./tool-search.js"
import { searchArguments, webSearchCalls } from "./web-search.js"

const outputIndex = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0

const hasOutputIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const toolCalls = (response: ResponseShape): ReadonlyArray<ToolCall> =>
  response.output.flatMap((item) =>
    item.type === "function_call"
      ? [
          {
            id: item.call_id,
            ...(item.async === true ? { async: true } : {}),
            type: "function" as const,
            function: { name: item.name, arguments: stripOpenAiCitations(item.arguments) }
          }
        ]
      : []
  )

const reasoningItemText = (item: ReasoningOutputItem): string => {
  const content = item.content?.map((part) => part.text).filter((text) => text.length > 0) ?? []
  return (content.length > 0 ? content : item.summary.map((part) => part.text))
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const rawResponseText = (response: ResponseShape): string | null => {
  const parts = response.output.flatMap((item) => {
    if (item.type !== "message") return []
    const text = messageItemText(item)
    return text.length === 0 ? [] : [text]
  })
  return parts.length === 0 ? null : parts.join("")
}

const responseText = (response: ResponseShape): string | null => {
  const text = rawResponseText(response)
  return text === null ? null : stripOpenAiCitations(text)
}

const reasoningText = (response: ResponseShape): string | null => {
  const parts = response.output.flatMap((item) => {
    if (item.type !== "reasoning") return []
    const text = reasoningItemText(item)
    return text.length === 0 ? [] : [text]
  })
  return parts.length === 0 ? null : parts.join("\n\n")
}

const outputParts = (response: ResponseShape): ReadonlyArray<AssistantOutputPart> => {
  const citationFilter = new OpenAiCitationFilter()
  const parts = response.output.flatMap((item): ReadonlyArray<AssistantOutputPart> => {
    switch (item.type) {
      case "message": {
        const text = citationFilter.push(messageItemText(item))
        return text.length === 0
          ? []
          : [
              {
                type: "text",
                text,
                ...(item.phase === undefined || item.phase === null ? {} : { phase: item.phase })
              }
            ]
      }
      case "reasoning": {
        const text = reasoningItemText(item)
        return text.length === 0 ? [] : [{ type: "reasoning", text }]
      }
      case "function_call":
        return [{ type: "tool_call", tool_call_id: item.call_id, execution: "runtime" }]
      case "web_search_call":
      case "tool_search_call":
        return [{ type: "tool_call", tool_call_id: item.id, execution: "provider" }]
    }
  })
  citationFilter.finish()
  return parts
}

const replayItems = (output: ReadonlyArray<OutputItem | ToolSearchOutputInputItem>): JsonValue =>
  output as unknown as JsonValue

const completion = (
  response: ResponseShape,
  requestedModel: string,
  finishReason: FinishReason,
  toolSearch: ToolSearch | undefined
): CompletionResponse => {
  const calls = toolCalls(response)
  const searches = answerToolSearches(response.output, toolSearch)
  const providerCalls = [...webSearchCalls(response), ...searches.calls]
  const usage = response.usage
  const cacheReadTokens = usage?.input_tokens_details.cached_tokens ?? 0
  const cacheWriteTokens = usage?.input_tokens_details.cache_write_tokens ?? 0
  return {
    _tag: "Completed",
    message: {
      role: "assistant",
      content: responseText(response),
      tool_calls: calls.length === 0 ? null : calls,
      reasoning_content: reasoningText(response),
      ...(providerCalls.length === 0 ? {} : { provider_tool_calls: providerCalls }),
      output_parts: outputParts(response),
      provider_state: { [PROVIDER_STATE_KEY]: replayItems(searches.items) }
    },
    finish_reason: finishReason === "stop" && calls.length > 0 ? "tool_calls" : finishReason,
    usage: {
      prompt_tokens: Math.max(0, (usage?.input_tokens ?? 0) - cacheReadTokens - cacheWriteTokens),
      completion_tokens: usage?.output_tokens ?? 0,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens
    },
    model: requestedModel
  }
}

const usageFrom = (value: unknown): ResponseUsage | null => {
  const raw = asRecord(value)
  if (raw === null) return null
  const details = asRecord(raw.input_tokens_details)
  const tokens = (input: unknown): number =>
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : 0
  return {
    input_tokens: tokens(raw.input_tokens),
    input_tokens_details: {
      cached_tokens: tokens(details?.cached_tokens),
      cache_write_tokens: tokens(details?.cache_write_tokens)
    },
    output_tokens: tokens(raw.output_tokens)
  }
}

export const responseCode = (event: RawResponseEvent): string | null => {
  const response = asRecord(event.response)
  const responseError = asRecord(response?.error)
  const eventError = asRecord(event.error)
  return (
    stringValue(responseError?.code) ?? stringValue(eventError?.code) ?? stringValue(event.code)
  )
}

const responseMessage = (event: RawResponseEvent): string | null => {
  const response = asRecord(event.response)
  const responseError = asRecord(response?.error)
  const eventError = asRecord(event.error)
  return (
    stringValue(responseError?.message) ??
    stringValue(eventError?.message) ??
    stringValue(event.message)
  )
}

export const responseFailureMessage = (event: RawResponseEvent): string => {
  const code = responseCode(event)
  const raw = responseMessage(event)
  const message = raw === null ? undefined : clipLine(raw, MAX_STATUS_DETAIL_CHARS)
  const label =
    code === null ? "OpenAI could not complete the response" : `OpenAI response failed (${code})`
  return message === undefined || message.length === 0 ? label : `${label}: ${message}`
}

export const makeEventMapper = (
  requestedModel: string,
  toolSearch?: ToolSearch
): ((event: RawResponseEvent) => ReadonlyArray<ModelStreamItem>) => {
  const items: Array<OutputItem> = []
  const functionCallsByIndex = new Map<number, string>()
  const citationFilter = new OpenAiCitationFilter()
  let outputText = ""
  let reasoning = ""
  let fallbackSequence = 0

  const fallbackItemId = (value: unknown): string =>
    hasOutputIndex(value)
      ? `${SYNTHETIC_OUTPUT_ID_PREFIX}${value}`
      : `${SYNTHETIC_OUTPUT_ID_PREFIX}event-${fallbackSequence++}`

  const upsert = (item: OutputItem): void => {
    const key = item.type === "function_call" ? item.call_id : item.id
    const index = items.findIndex(
      (candidate) =>
        candidate.type === item.type &&
        (candidate.type === "function_call" ? candidate.call_id : candidate.id) === key
    )
    if (index < 0) items.push(item)
    else items[index] = item
  }

  const terminal = (
    value: unknown,
    options: { readonly requireCompletedCalls?: boolean } = {}
  ): ResponseShape => {
    const raw = asRecord(value)
    if (raw === null)
      throw new SemanticResponseError("OpenAI returned an invalid terminal response")
    if (
      options.requireCompletedCalls === true &&
      (!Array.isArray(raw.output) || raw.output.length === 0) &&
      items.some((item) => item.type === "function_call" && item.status !== "completed")
    ) {
      throw new SemanticResponseError("OpenAI completed with an unfinished function call")
    }
    const responseItems =
      Array.isArray(raw.output) && raw.output.length > 0
        ? raw.output.map((item, index) =>
            normalizeOutputItem(item, `${SYNTHETIC_OUTPUT_ID_PREFIX}${index}`)
          )
        : [...items]
    const snapshot: ResponseShape = { output: responseItems, usage: usageFrom(raw.usage) }
    if (rawResponseText(snapshot) === null && outputText.length > 0) {
      responseItems.push(
        normalizeOutputItem(
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: outputText }]
          },
          `${SYNTHETIC_OUTPUT_ID_PREFIX}text-${fallbackSequence++}`
        )
      )
    }
    if (reasoningText(snapshot) === null && reasoning.length > 0) {
      responseItems.push(
        normalizeOutputItem(
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: reasoning }]
          },
          `${SYNTHETIC_OUTPUT_ID_PREFIX}reasoning-${fallbackSequence++}`
        )
      )
    }
    return snapshot
  }

  const emittedItems = new Set<string>()
  const readyItems = (output: ReadonlyArray<OutputItem>): ReadonlyArray<ModelStreamItem> =>
    output.flatMap((item) => {
      const key = item.type === "function_call" ? item.call_id : item.id
      if (emittedItems.has(key)) return []
      emittedItems.add(key)
      return [
        {
          _tag: "OutputItemReady",
          message: completion({ output: [item], usage: null }, requestedModel, "stop", toolSearch)
            .message
        }
      ]
    })

  return (event: RawResponseEvent): ReadonlyArray<ModelStreamItem> => {
    switch (event.type) {
      case "response.output_text.delta":
      case "response.refusal.delta": {
        const delta = stringValue(event.delta)
        if (delta === null) throw new SemanticResponseError("OpenAI returned an invalid text delta")
        outputText += delta
        const visibleDelta = citationFilter.push(delta)
        return visibleDelta.length === 0 ? [] : [{ _tag: "TextDelta", content: visibleDelta }]
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = stringValue(event.delta)
        if (delta === null)
          throw new SemanticResponseError("OpenAI returned an invalid reasoning delta")
        reasoning += delta
        return [{ _tag: "ReasoningDelta", content: delta }]
      }
      case "response.output_item.added": {
        const item = normalizeOutputItem(event.item, fallbackItemId(event.output_index))
        upsert(item.type === "function_call" ? { ...item, status: "in_progress" } : item)
        if (item.type === "function_call") {
          functionCallsByIndex.set(outputIndex(event.output_index), item.call_id)
          return [
            {
              _tag: "ToolCallDelta",
              index: outputIndex(event.output_index),
              tool_id: item.call_id,
              name: item.name,
              arguments_delta: item.arguments,
              done: false
            }
          ]
        }
        if (item.type === "tool_search_call") {
          return [{ _tag: "ProviderToolCall", call: pendingToolSearchCall(item) }]
        }
        if (item.type === "web_search_call") {
          return [
            {
              _tag: "ProviderToolCall",
              call: {
                id: item.id,
                name: WEB_SEARCH_TOOL_NAME,
                arguments: searchArguments(item),
                result: "",
                done: false,
                loaded_tool_names: [],
                source_refs: []
              }
            }
          ]
        }
        return []
      }
      case "response.output_item.done": {
        const item = normalizeOutputItem(event.item, fallbackItemId(event.output_index))
        upsert(item)
        if (item.type === "function_call") {
          functionCallsByIndex.set(outputIndex(event.output_index), item.call_id)
        }
        return readyItems([item])
      }
      case "response.function_call_arguments.delta": {
        const delta = stringValue(event.delta)
        if (delta === null)
          throw new SemanticResponseError("OpenAI returned invalid function arguments")
        const callId = functionCallsByIndex.get(outputIndex(event.output_index))
        const index = items.findIndex(
          (item) => item.type === "function_call" && item.call_id === callId
        )
        const item = items[index]
        if (item?.type === "function_call") {
          items[index] = { ...item, arguments: item.arguments + delta }
        }
        return [
          {
            _tag: "ToolCallDelta",
            index: outputIndex(event.output_index),
            arguments_delta: delta,
            done: false
          }
        ]
      }
      case "response.function_call_arguments.done": {
        const callId = functionCallsByIndex.get(outputIndex(event.output_index))
        const index = items.findIndex(
          (item) => item.type === "function_call" && item.call_id === callId
        )
        const item = items[index]
        if (item?.type === "function_call") {
          items[index] = {
            ...item,
            arguments: stringValue(event.arguments) ?? item.arguments,
            status: "completed"
          }
        }
        return [
          {
            _tag: "ToolCallDelta",
            index: outputIndex(event.output_index),
            ...(typeof event.name === "string" ? { name: event.name } : {}),
            arguments_delta: null,
            done: true
          }
        ]
      }
      case "response.completed": {
        citationFilter.finish()
        const response = terminal(event.response, { requireCompletedCalls: true })
        return [
          ...readyItems(response.output),
          {
            ...completion(response, requestedModel, "stop", toolSearch),
            ...(asRecord(event.response)?.end_turn === false ? { continuation: true } : {})
          }
        ]
      }
      case "response.incomplete": {
        const response = asRecord(event.response)
        const details = asRecord(response?.incomplete_details)
        const reason = details === null ? null : stringValue(details.reason)
        if (reason === "max_output_tokens") {
          citationFilter.finish()
          const snapshot = terminal(response)
          const completed = {
            ...snapshot,
            output: snapshot.output.filter(
              (item) => item.type !== "function_call" || emittedItems.has(item.call_id)
            )
          }
          return [
            ...readyItems(completed.output),
            completion(completed, requestedModel, "length", toolSearch)
          ]
        }
        if (reason === "content_filter") {
          citationFilter.finish()
          return [completion(terminal(response), requestedModel, "content_filter", toolSearch)]
        }
        throw new SemanticResponseError("OpenAI returned an incomplete response")
      }
      case "response.failed":
      case "error": {
        const message = responseFailureMessage(event)
        const declared = TERMINAL_RESPONSE_CODES[responseCode(event) ?? ""]
        if (declared !== undefined) throw new SemanticResponseError(message, declared)
        throw new RetryableProviderError(message)
      }
      default:
        return []
    }
  }
}
