import { isRecord } from "@arden-hq/std/json"

import type {
  AssistantMessage,
  ChatMessage,
  JsonObject,
  JsonValue,
  MessageOrigin
} from "../../contracts/messages.js"
import type { ModelProviderRequest } from "../../contracts/provider.js"
import type { ToolDeclaration } from "../../contracts/tools.js"
import {
  contextBlockText,
  MISSING_TOOL_OUTPUT,
  orderToolHistory,
  sameOrigin,
  type ToolHistoryBatch,
  type ToolHistoryWire
} from "../kit/index.js"
import type { ChatCompletionsCompat } from "./compat.js"
import { ChatCompletionsProviderError } from "./errors.js"

/** This wire's name in a message origin, and its key in `provider_state`. */
export const API = "chat-completions"

interface CacheControl {
  readonly type: "ephemeral"
}

type ContentPart =
  | { readonly type: "text"; readonly text: string; readonly cache_control?: CacheControl }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } }

type Content = string | ReadonlyArray<ContentPart>

interface WireToolCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

type WireMessage =
  | { readonly role: "system" | "developer" | "user"; readonly content: Content }
  | {
      readonly role: "assistant"
      readonly content: Content
      readonly tool_calls?: ReadonlyArray<WireToolCall>
      readonly reasoning_details?: ReadonlyArray<JsonValue>
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: Content }

interface WireTool {
  readonly type: "function"
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Readonly<Record<string, unknown>>
  }
  readonly cache_control?: CacheControl
}

export interface ChatCompletionsPayload {
  readonly [key: string]: unknown
  readonly model: string
  readonly messages: ReadonlyArray<WireMessage>
  readonly stream: true
  readonly tools?: ReadonlyArray<WireTool>
}

/** Everything the request body depends on besides the request itself. */
export interface PayloadContext {
  readonly providerId: string
  readonly label: string
  readonly compat: ChatCompletionsCompat
  readonly extraBody: JsonObject
}

const EPHEMERAL: CacheControl = { type: "ephemeral" }

/**
 * The request body for one model step. A request this adapter cannot build
 * from the stored history or the tool catalog is Arden's own defect, never
 * the person's: it fails as `request_invalid`, like a request the server refuses.
 */
export const makePayload = (
  request: ModelProviderRequest,
  context: PayloadContext
): ChatCompletionsPayload => {
  try {
    return buildPayload(request, context)
  } catch (error) {
    if (error instanceof ChatCompletionsProviderError && error.code === "provider_error") {
      throw new ChatCompletionsProviderError(error.message, "request_invalid")
    }
    throw error
  }
}

const buildPayload = (
  request: ModelProviderRequest,
  context: PayloadContext
): ChatCompletionsPayload => {
  const { compat, label } = context
  const fail = (message: string) => new ChatCompletionsProviderError(`${label} ${message}`)
  if (request.model.trim().length === 0) throw fail("needs a model ID")
  if (request.toolSearch !== undefined) throw fail("cannot search tools on the client")
  if (request.responseFormat !== undefined && compat.structuredOutput === "none")
    throw fail("route does not constrain output to a JSON schema")
  const tools = request.tools.map((tool) => functionTool(tool, fail))
  if (request.toolChoice === "required" && tools.length === 0)
    throw fail("needs at least one function tool for a required tool choice")
  const messages = convertMessages(request, context)
  const body: ChatCompletionsPayload = {
    ...context.extraBody,
    model: request.model,
    messages,
    stream: true,
    ...(compat.usageInStream ? { stream_options: { include_usage: true } } : {}),
    ...(tools.length === 0 ? {} : { tools }),
    ...(tools.length === 0 || request.toolChoice === "auto"
      ? {}
      : { tool_choice: request.toolChoice }),
    ...(tools.length > 0 && compat.parallelToolCalls ? { parallel_tool_calls: true } : {}),
    ...(request.maxOutputTokens === undefined
      ? {}
      : { [compat.maxTokensField]: request.maxOutputTokens }),
    ...reasoningFields(request.reasoningEffort, compat),
    ...(request.responseFormat === undefined
      ? {}
      : {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.responseFormat.name,
              schema: request.responseFormat.schema,
              strict: true
            }
          }
        })
  }
  // `request.cacheScope` has no field on this wire: llama.cpp reuses its KV
  // cache by prefix on its own, and OpenRouter caches by prefix or by the
  // `cache_control` breakpoints below.
  return compat.cacheControl === "anthropic" ? withCacheBreakpoints(body) : body
}

const reasoningFields = (
  effort: string | undefined,
  compat: ChatCompletionsCompat
): Readonly<Record<string, unknown>> => {
  if (effort === undefined) return {}
  switch (compat.reasoningEffort) {
    case "reasoning_effort":
      return { reasoning_effort: effort }
    case "openrouter":
      return { reasoning: { effort } }
    case "none":
      return {}
  }
}

const functionTool = (tool: ToolDeclaration, fail: (message: string) => Error): WireTool => {
  if (tool.hosted === true) throw fail(`has no hosted tool ${tool.name}`)
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }
}

/**
 * Chat Completions answers every `tool_calls` entry with `tool` messages
 * right after it; the kit orders stored history so that holds.
 */
const historyWire = (label: string): ToolHistoryWire<WireMessage> => ({
  name: "tool history",
  // The loop projects background calls into a running receipt plus a later
  // completion message for a route with `asyncTools: "message"`, so no call
  // reaches this wire unanswered by design.
  calls: (item) =>
    item.role === "assistant"
      ? (item.tool_calls ?? []).map((call) => ({ id: call.id, async: false }))
      : [],
  answers: (item) => (item.role === "tool" ? { id: item.tool_call_id } : undefined),
  missingOutput: (callId) => ({ role: "tool", tool_call_id: callId, content: MISSING_TOOL_OUTPUT }),
  fail: (message) => new ChatCompletionsProviderError(`${label}: ${message}`)
})

const convertMessages = (
  request: ModelProviderRequest,
  context: PayloadContext
): ReadonlyArray<WireMessage> => {
  const { compat, label } = context
  const leading = request.messages.findIndex((message) => message.role !== "system")
  const instructionMessages = leading < 0 ? request.messages : request.messages.slice(0, leading)
  const instructions = instructionMessages
    .map((message) => textContent(message, label))
    .filter((text) => text.length > 0)
    .join("\n\n")
  const origin: MessageOrigin = { provider: context.providerId, api: API, model: request.model }
  const batches = (leading < 0 ? [] : request.messages.slice(leading)).flatMap(
    (message): ReadonlyArray<ToolHistoryBatch<WireMessage>> => {
      switch (message.role) {
        // A system or developer message inside the conversation stays where
        // it is, in the route's one instruction role: OpenAI accepts it
        // anywhere, and llama.cpp renders it in place (checked against
        // gemma-4 on 2026-11-15). A `developer` message's `loaded_tools` have
        // no form here, as the route searches no tools; `content` is its
        // plain-text fallback.
        case "system":
        case "developer": {
          const content = textContent(message, label)
          return content.length === 0
            ? []
            : [{ items: [{ role: compat.systemRole, content }], deferWhileCallsPending: true }]
        }
        case "user": {
          if (message.async_tool_launch !== undefined) return []
          if (message.interaction !== undefined)
            return [
              {
                items: [{ role: "user", content: request.renderInteraction(message.interaction) }],
                deferWhileCallsPending: false
              }
            ]
          return [
            {
              items: [{ role: "user", content: userContent(message.content, compat, label) }],
              deferWhileCallsPending: true
            }
          ]
        }
        case "tool":
          return [
            {
              items: [
                {
                  role: "tool",
                  tool_call_id: message.tool_call_id,
                  content: textContent(message, label)
                }
              ],
              deferWhileCallsPending: false
            }
          ]
        case "assistant": {
          const item = assistantItem(message, origin, label)
          return item === undefined ? [] : [{ items: [item], deferWhileCallsPending: false }]
        }
      }
    }
  )
  const conversation = orderToolHistory(batches, historyWire(label))
  return instructions.length === 0
    ? conversation
    : [{ role: compat.systemRole, content: instructions }, ...conversation]
}

/**
 * An assistant turn on this wire: its text as a string, its runtime calls,
 * and its replay state. `provider_tool_calls` (calls another provider ran
 * upstream) have no form on this wire and are never sent: their results
 * already reached the model as that turn's text. Reasoning text is never
 * replayed in `content`.
 */
const assistantItem = (
  message: AssistantMessage,
  origin: MessageOrigin,
  label: string
): WireMessage | undefined => {
  const content = textContent(message, label)
  const calls = (message.tool_calls ?? []).map((call): WireToolCall => ({
    id: call.id,
    type: "function",
    function: { name: call.function.name, arguments: call.function.arguments }
  }))
  const details = replayedReasoningDetails(message, origin)
  if (content.length === 0 && calls.length === 0 && details === undefined) return undefined
  return {
    role: "assistant",
    content,
    ...(calls.length === 0 ? {} : { tool_calls: calls }),
    ...(details === undefined ? {} : { reasoning_details: details })
  }
}

/**
 * OpenRouter's `reasoning_details` go back verbatim, but only to the
 * provider, wire and model that wrote them: encrypted reasoning and
 * signatures are bound to their issuer, a different model refuses or
 * misreads them, and every reference agent drops them on a mismatch.
 */
const replayedReasoningDetails = (
  message: AssistantMessage,
  origin: MessageOrigin
): ReadonlyArray<JsonValue> | undefined => {
  if (message.origin === undefined || !sameOrigin(message.origin, origin)) return undefined
  const state = message.provider_state?.[API]
  const details = isRecord(state) ? state.reasoning_details : undefined
  return Array.isArray(details) && details.length > 0 ? details : undefined
}

const textContent = (message: ChatMessage, label: string): string => {
  if (typeof message.content === "string") return message.content
  if (message.content === null || message.content === undefined) return ""
  throw new ChatCompletionsProviderError(
    `${label} supports text-only ${message.role} message content`
  )
}

const userContent = (
  content: string | null | undefined | ReadonlyArray<unknown>,
  compat: ChatCompletionsCompat,
  label: string
): Content => {
  if (typeof content === "string") return content
  if (content === null || content === undefined) return ""
  return content.map((block): ContentPart => {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string")
      return { type: "text", text: block.text }
    const context = contextBlockText(block)
    if (context !== undefined) return { type: "text", text: context }
    if (isRecord(block) && block.type === "image") {
      if (!compat.imageInput)
        throw new ChatCompletionsProviderError(`${label} route does not accept image input`)
      if (
        (block.media_type === "image/png" || block.media_type === "image/jpeg") &&
        typeof block.data === "string" &&
        block.data.length > 0
      )
        return {
          type: "image_url",
          image_url: { url: `data:${block.media_type};base64,${block.data}` }
        }
    }
    throw new ChatCompletionsProviderError(`${label} received unsupported user content`)
  })
}

/**
 * Anthropic prompt-cache breakpoints: the last tool, the first instruction
 * message and the last conversation message that has text to carry one.
 * String content becomes one text part, the only place it does.
 */
const withCacheBreakpoints = (body: ChatCompletionsPayload): ChatCompletionsPayload => {
  const tools = body.tools?.map((tool, index, all) =>
    index === all.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool
  )
  const firstInstruction = body.messages
    .flatMap((message, index) =>
      message.role === "system" || message.role === "developer" ? [index] : []
    )
    .at(0)
  const lastTurn = body.messages
    .flatMap((message, index) =>
      (message.role === "user" || message.role === "assistant" || message.role === "tool") &&
      markedContent(message.content) !== undefined
        ? [index]
        : []
    )
    .at(-1)
  const messages = body.messages.map((message, index) => {
    if (index !== firstInstruction && index !== lastTurn) return message
    const content = markedContent(message.content)
    return content === undefined ? message : { ...message, content }
  })
  return { ...body, messages, ...(tools === undefined ? {} : { tools }) }
}

const markedContent = (content: Content): Content | undefined => {
  if (typeof content === "string")
    return content.length === 0
      ? undefined
      : [{ type: "text", text: content, cache_control: EPHEMERAL }]
  const last = content.flatMap((part, index) => (part.type === "text" ? [index] : [])).at(-1)
  if (last === undefined) return undefined
  return content.map((part, index) =>
    index === last && part.type === "text" ? { ...part, cache_control: EPHEMERAL } : part
  )
}
