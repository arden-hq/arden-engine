import { syntheticOutputId } from "./output-id.js"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { clipLine } from "@arden-hq/std/text"
import {
  TOOL_EXECUTION,
  toolCallPart,
  type AssistantOutputPart,
  type JsonValue,
  type MessageOrigin,
  type ToolCall
} from "../../contracts/messages.js"
import {
  FinishReason,
  type CompletionResponse,
  type ModelStreamItem
} from "../../contracts/provider.js"
import type { ToolSearch } from "../../contracts/tools.js"
import { OpenAiCitationFilter, stripOpenAiCitations } from "./citations.js"
import {
  MAX_STATUS_DETAIL_CHARS,
  reportedCost,
  RetryableProviderError,
  SemanticResponseError
} from "../kit/index.js"
import { TERMINAL_RESPONSE_CODES } from "./errors.js"
import {
  API,
  asRecord,
  INCOMPLETE_REASON,
  incompleteReason,
  isResponseEventType,
  ITEM_STATUS,
  messageItemText,
  normalizeOutputItem,
  PROVIDER_STATE_KEY,
  RESPONSE_EVENT_TYPE,
  RESPONSE_ITEM_TYPE,
  stringValue,
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
    item.type === RESPONSE_ITEM_TYPE.functionCall
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

const itemKey = (item: OutputItem): string =>
  item.type === RESPONSE_ITEM_TYPE.functionCall ? item.call_id : item.id

const reasoningItemText = (item: ReasoningOutputItem): string => {
  const content = item.content?.map((part) => part.text).filter((text) => text.length > 0) ?? []
  return (content.length > 0 ? content : item.summary.map((part) => part.text))
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const rawResponseText = (response: ResponseShape): string | null => {
  const parts = response.output.flatMap((item) => {
    if (item.type !== RESPONSE_ITEM_TYPE.message) return []
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
    if (item.type !== RESPONSE_ITEM_TYPE.reasoning) return []
    const text = reasoningItemText(item)
    return text.length === 0 ? [] : [text]
  })
  return parts.length === 0 ? null : parts.join("\n\n")
}

const outputParts = (response: ResponseShape): ReadonlyArray<AssistantOutputPart> => {
  const citationFilter = new OpenAiCitationFilter()
  const parts = response.output.flatMap((item): ReadonlyArray<AssistantOutputPart> => {
    switch (item.type) {
      case RESPONSE_ITEM_TYPE.message: {
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
      case RESPONSE_ITEM_TYPE.reasoning: {
        const text = reasoningItemText(item)
        return text.length === 0 ? [] : [{ type: "reasoning", text }]
      }
      case RESPONSE_ITEM_TYPE.functionCall:
        return [toolCallPart(item.call_id, TOOL_EXECUTION.runtime)]
      case RESPONSE_ITEM_TYPE.webSearchCall:
      case RESPONSE_ITEM_TYPE.toolSearchCall:
        return [toolCallPart(item.id, TOOL_EXECUTION.provider)]
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
  toolSearch: ToolSearch | undefined,
  origin: MessageOrigin
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
      role: ROLE.assistant,
      content: responseText(response),
      tool_calls: calls.length === 0 ? null : calls,
      reasoning_content: reasoningText(response),
      ...(providerCalls.length === 0 ? {} : { provider_tool_calls: providerCalls }),
      output_parts: outputParts(response),
      provider_state: { [PROVIDER_STATE_KEY]: replayItems(searches.items) },
      origin
    },
    finish_reason:
      finishReason === FinishReason.STOP && calls.length > 0
        ? FinishReason.TOOL_CALLS
        : finishReason,
    usage: {
      prompt_tokens: Math.max(0, (usage?.input_tokens ?? 0) - cacheReadTokens - cacheWriteTokens),
      completion_tokens: usage?.output_tokens ?? 0,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      cost: usage?.cost
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
    output_tokens: tokens(raw.output_tokens),
    cost: reportedCost(raw)
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

export const makeEventMapper = ({
  requestedModel,
  toolSearch,
  providerId
}: {
  readonly requestedModel: string
  readonly toolSearch: ToolSearch | undefined
  readonly providerId: string
}): ((event: RawResponseEvent) => ReadonlyArray<ModelStreamItem>) => {
  let answeredBy = requestedModel
  const origin = (): MessageOrigin => ({
    provider: providerId,
    api: API,
    model: answeredBy,
    requested_model: requestedModel
  })
  const items: Array<OutputItem> = []
  const functionCallsByIndex = new Map<number, string>()
  const citationFilter = new OpenAiCitationFilter()
  let outputText = ""
  let reasoning = ""
  let fallbackSequence = 0

  const fallbackItemId = (value: unknown): string =>
    hasOutputIndex(value)
      ? syntheticOutputId(value)
      : syntheticOutputId(`event-${fallbackSequence++}`)

  const functionCallIndex = (outputIndexValue: unknown): number => {
    const callId = functionCallsByIndex.get(outputIndex(outputIndexValue))
    return items.findIndex(
      (item) => item.type === RESPONSE_ITEM_TYPE.functionCall && item.call_id === callId
    )
  }

  const upsert = (item: OutputItem): void => {
    const key = itemKey(item)
    const index = items.findIndex(
      (candidate) => candidate.type === item.type && itemKey(candidate) === key
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
      items.some(
        (item) =>
          item.type === RESPONSE_ITEM_TYPE.functionCall && item.status !== ITEM_STATUS.completed
      )
    ) {
      throw new SemanticResponseError("OpenAI completed with an unfinished function call")
    }
    const responseItems =
      Array.isArray(raw.output) && raw.output.length > 0
        ? raw.output.map((item, index) => normalizeOutputItem(item, syntheticOutputId(index)))
        : [...items]
    const snapshot: ResponseShape = { output: responseItems, usage: usageFrom(raw.usage) }
    if (rawResponseText(snapshot) === null && outputText.length > 0) {
      responseItems.push(
        normalizeOutputItem(
          {
            type: "message",
            role: ROLE.assistant,
            content: [{ type: "output_text", text: outputText }]
          },
          syntheticOutputId(`text-${fallbackSequence++}`)
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
          syntheticOutputId(`reasoning-${fallbackSequence++}`)
        )
      )
    }
    return snapshot
  }

  const emittedItems = new Set<string>()
  const readyItems = (output: ReadonlyArray<OutputItem>): ReadonlyArray<ModelStreamItem> =>
    output.flatMap((item) => {
      const key = itemKey(item)
      if (emittedItems.has(key)) return []
      emittedItems.add(key)
      return [
        {
          _tag: "OutputItemReady",
          message: completion(
            { output: [item], usage: null },
            requestedModel,
            "stop",
            toolSearch,
            origin()
          ).message
        }
      ]
    })

  return (event: RawResponseEvent): ReadonlyArray<ModelStreamItem> => {
    const reported = stringValue(asRecord(event.response)?.model)
    if (reported !== null && reported.length > 0) answeredBy = reported
    switch (isResponseEventType(event.type) ? event.type : undefined) {
      case RESPONSE_EVENT_TYPE.outputTextDelta:
      case RESPONSE_EVENT_TYPE.refusalDelta: {
        const delta = stringValue(event.delta)
        if (delta === null) throw new SemanticResponseError("OpenAI returned an invalid text delta")
        outputText += delta
        const visibleDelta = citationFilter.push(delta)
        return visibleDelta.length === 0 ? [] : [{ _tag: "TextDelta", content: visibleDelta }]
      }
      case RESPONSE_EVENT_TYPE.reasoningSummaryTextDelta:
      case RESPONSE_EVENT_TYPE.reasoningTextDelta: {
        const delta = stringValue(event.delta)
        if (delta === null)
          throw new SemanticResponseError("OpenAI returned an invalid reasoning delta")
        reasoning += delta
        return [{ _tag: "ReasoningDelta", content: delta }]
      }
      case RESPONSE_EVENT_TYPE.outputItemAdded: {
        const item = normalizeOutputItem(event.item, fallbackItemId(event.output_index))
        upsert(
          item.type === RESPONSE_ITEM_TYPE.functionCall
            ? { ...item, status: ITEM_STATUS.inProgress }
            : item
        )
        if (item.type === RESPONSE_ITEM_TYPE.functionCall) {
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
        if (item.type === RESPONSE_ITEM_TYPE.toolSearchCall) {
          return [{ _tag: "ProviderToolCall", call: pendingToolSearchCall(item) }]
        }
        if (item.type === RESPONSE_ITEM_TYPE.webSearchCall) {
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
      case RESPONSE_EVENT_TYPE.outputItemDone: {
        const item = normalizeOutputItem(event.item, fallbackItemId(event.output_index))
        upsert(item)
        if (item.type === RESPONSE_ITEM_TYPE.functionCall) {
          functionCallsByIndex.set(outputIndex(event.output_index), item.call_id)
        }
        return readyItems([item])
      }
      case RESPONSE_EVENT_TYPE.functionCallArgumentsDelta: {
        const delta = stringValue(event.delta)
        if (delta === null)
          throw new SemanticResponseError("OpenAI returned invalid function arguments")
        const index = functionCallIndex(event.output_index)
        const item = items[index]
        if (item?.type === RESPONSE_ITEM_TYPE.functionCall) {
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
      case RESPONSE_EVENT_TYPE.functionCallArgumentsDone: {
        const index = functionCallIndex(event.output_index)
        const item = items[index]
        if (item?.type === RESPONSE_ITEM_TYPE.functionCall) {
          items[index] = {
            ...item,
            arguments: stringValue(event.arguments) ?? item.arguments,
            status: ITEM_STATUS.completed
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
      case RESPONSE_EVENT_TYPE.completed: {
        citationFilter.finish()
        const response = terminal(event.response, { requireCompletedCalls: true })
        return [
          ...readyItems(response.output),
          {
            ...completion(response, requestedModel, "stop", toolSearch, origin()),
            ...(asRecord(event.response)?.end_turn === false ? { continuation: true } : {})
          }
        ]
      }
      case RESPONSE_EVENT_TYPE.incomplete: {
        const response = asRecord(event.response)
        const reason = incompleteReason(event)
        if (reason === INCOMPLETE_REASON.maxOutputTokens) {
          citationFilter.finish()
          const snapshot = terminal(response)
          const completed = {
            ...snapshot,
            output: snapshot.output.filter(
              (item) =>
                item.type !== RESPONSE_ITEM_TYPE.functionCall || emittedItems.has(item.call_id)
            )
          }
          return [
            ...readyItems(completed.output),
            completion(completed, requestedModel, "length", toolSearch, origin())
          ]
        }
        if (reason === INCOMPLETE_REASON.contentFilter) {
          citationFilter.finish()
          return [
            completion(terminal(response), requestedModel, "content_filter", toolSearch, origin())
          ]
        }
        throw new SemanticResponseError("OpenAI returned an incomplete response")
      }
      case RESPONSE_EVENT_TYPE.failed:
      case RESPONSE_EVENT_TYPE.error: {
        const message = responseFailureMessage(event)
        const declared = TERMINAL_RESPONSE_CODES[responseCode(event) ?? ""]
        if (declared !== undefined) throw new SemanticResponseError(message, declared)
        throw new RetryableProviderError(message)
      }
      case RESPONSE_EVENT_TYPE.created:
      case RESPONSE_EVENT_TYPE.done:
      case RESPONSE_EVENT_TYPE.steerAccepted:
      case RESPONSE_EVENT_TYPE.steerFailed:
      case RESPONSE_EVENT_TYPE.steerPending:
      case undefined:
        return []
    }
  }
}
