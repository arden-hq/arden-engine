import { isRecord } from "@arden-hq/std/json"

import type {
  AssistantMessage,
  ChatMessage,
  JsonObject,
  JsonValue,
  ProviderToolCall
} from "../../contracts/messages.js"
import type { ModelProviderRequest } from "../../contracts/provider.js"
import { loadedToolNames, type ToolDeclaration } from "../../contracts/tools.js"
import {
  contextBlockText,
  isToolSearchCall,
  MISSING_TOOL_OUTPUT,
  type MessageRoute,
  orderToolHistory,
  sameRoute,
  TOOL_SEARCH_TOOL_NAME,
  type ToolHistoryBatch,
  type ToolHistoryWire,
  projectToolHistory,
  rendersAsText
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
  if (request.responseFormat !== undefined && compat.structuredOutput === "none")
    throw fail("route does not constrain output to a JSON schema")
  const tools = declaredTools(request).map((tool) => functionTool(tool, fail))
  const names = tools.map((tool) => tool.function.name)
  const repeated = names.find((name, index) => names.indexOf(name) !== index)
  if (repeated !== undefined) throw fail(`declares the tool ${repeated} twice`)
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
    ...(tools.length === 0 ||
    request.toolChoice === "auto" ||
    (request.toolChoice === "none" && compat.toolChoiceNone === "unenforced")
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

/**
 * The tools one request declares. With a client search, that is the core
 * set, the search itself as an ordinary function tool (this wire has no
 * search item; the adapter answers the call), and every deferred tool the
 * history has loaded so far, in load order. Loaded tools come from the
 * provider-neutral history (`loadedToolNames`), so tools a search on another
 * wire loaded stay declared here.
 *
 * Cost on llama.cpp: a chat template renders the tools near the start of the
 * prompt, before the conversation, and the server reuses its KV cache only up
 * to the first token that differs. Loading a tool therefore changes the
 * prompt from the end of the old tool list, and the server reads everything
 * after it again (measured in the live check, see README "Chat Completions").
 * Load order keeps that point as late as the template allows: loaded tools
 * are appended, never sorted in.
 */
const declaredTools = (request: ModelProviderRequest): ReadonlyArray<ToolDeclaration> => {
  const search = request.toolSearch
  if (search === undefined) return request.tools
  const core = new Set(request.tools.map((tool) => tool.name))
  const loaded = [...loadedToolNames(request.messages)].filter((name) => !core.has(name))
  return [
    ...request.tools,
    { name: TOOL_SEARCH_TOOL_NAME, description: search.description, parameters: search.parameters },
    ...search.lookup(loaded)
  ]
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
  const messages = projectToolHistory({ messages: request.messages, nativeAsync: false })
  const leading = messages.findIndex((message) => message.role !== "system")
  const instructionMessages = leading < 0 ? messages : messages.slice(0, leading)
  const instructions = instructionMessages
    .map((message) => textContent(message, label))
    .filter((text) => text.length > 0)
    .join("\n\n")
  const route: MessageRoute = {
    provider: context.providerId,
    api: API,
    requested_model: request.model
  }
  const batches = (leading < 0 ? [] : messages.slice(leading)).flatMap(
    (message): ReadonlyArray<ToolHistoryBatch<WireMessage>> => {
      switch (message.role) {
        // A system or developer message inside the conversation stays where
        // it is, in the route's one instruction role: OpenAI accepts it
        // anywhere, and llama.cpp renders it in place (checked against
        // gemma-4 on 2026-11-15). A `developer` message's `loaded_tools` are
        // declared as tools (`declaredTools`); its `content` says so in text.
        case "system":
        case "developer": {
          const content = textContent(message, label)
          return content.length === 0
            ? []
            : [{ items: [{ role: compat.systemRole, content }], deferWhileCallsPending: true }]
        }
        case "interaction":
          return [
            {
              items: [
                {
                  role: "user",
                  content: rendersAsText(message)
                    ? request.renderInteraction(message, "text")
                    : userContent(message.content, compat, label)
                }
              ],
              deferWhileCallsPending: !rendersAsText(message)
            }
          ]
        case "user": {
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
          const item = assistantItem(message, route, label)
          if (item === undefined) return []
          return [
            {
              items: [item, ...searchesOf(message).map(searchResultItem)],
              deferWhileCallsPending: false
            }
          ]
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
 * The turn's tool searches, whichever wire answered them: each is replayed
 * as an ordinary call to the search tool, answered by a `tool` message with
 * the result the model read, rebuilt from the provider-neutral record alone.
 */
const searchesOf = (message: AssistantMessage): ReadonlyArray<ProviderToolCall> =>
  (message.provider_tool_calls ?? []).filter(isToolSearchCall)

const searchResultItem = (call: ProviderToolCall): WireMessage => ({
  role: "tool",
  tool_call_id: call.id,
  content: call.result === undefined || call.result.length === 0 ? MISSING_TOOL_OUTPUT : call.result
})

/**
 * An assistant turn on this wire: its text as a string, its calls in the
 * order the model wrote them (`output_parts`), and its replay state. Tool
 * searches are calls here like any other. Other `provider_tool_calls` (a
 * hosted tool another route ran upstream) have no form on this wire and are
 * never sent: their results already reached the model as that turn's text.
 * Reasoning text is never replayed in `content`.
 */
const assistantItem = (
  message: AssistantMessage,
  route: MessageRoute,
  label: string
): WireMessage | undefined => {
  const content = textContent(message, label)
  const written = new Map<string, WireToolCall>([
    ...searchesOf(message).map((call): [string, WireToolCall] => [
      call.id,
      {
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
      }
    ]),
    ...(message.tool_calls ?? []).map((call): [string, WireToolCall] => [
      call.id,
      {
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments }
      }
    ])
  ])
  const ordered = (message.output_parts ?? []).flatMap((part) =>
    part.type === "tool_call" ? [part.tool_call_id] : []
  )
  const calls = [
    ...new Set([...ordered.filter((id) => written.has(id)), ...written.keys()])
  ].flatMap((id) => {
    const call = written.get(id)
    return call === undefined ? [] : [call]
  })
  const details = replayedReasoningDetails(message, route)
  if (content.length === 0 && calls.length === 0 && details === undefined) return undefined
  return {
    role: "assistant",
    content,
    ...(calls.length === 0 ? {} : { tool_calls: calls }),
    ...(details === undefined ? {} : { reasoning_details: details })
  }
}

/**
 * OpenRouter's `reasoning_details` go back verbatim, but only on the route
 * that wrote them (`sameRoute`: this provider, this wire, the same requested
 * model ID). OpenRouter's docs ask for them back unmodified so a model keeps
 * its reasoning across tool calls
 * (https://openrouter.ai/docs/guides/best-practices/reasoning-tokens: "the
 * entire sequence of consecutive reasoning blocks must match the outputs
 * generated by the model"). Checked live on 2026-11-16 with a Claude Haiku
 * 5.5 thinking + tool call, a Gemini 3.1 Flash Lite thought signature and
 * GPT-6 Luna encrypted reasoning: step two succeeded with them and also
 * without them (OpenRouter fills the gap upstream), and OpenRouter accepted
 * Claude details sent to Gemini and Gemini details sent to Claude. Replay is
 * therefore what the docs ask for on the same route, and a model switch drops
 * the details rather than sending another model's signatures, as every
 * reference agent does. Plain reasoning text is never sent back.
 */
const replayedReasoningDetails = (
  message: AssistantMessage,
  route: MessageRoute
): ReadonlyArray<JsonValue> | undefined => {
  if (message.origin === undefined || !sameRoute(message.origin, route)) return undefined
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

const IMAGE_OMITTED = "(image omitted: this model does not take image input)"

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
      // A history is not tied to one model: a screenshot, an attachment or a
      // chat moved over from a vision model reaches a text-only route too.
      // Failing would fail every later request of the chat, so the model is
      // told the image was left out (pi-ai `transcript-transform.ts` does the same).
      if (!compat.imageInput) return { type: "text", text: IMAGE_OMITTED }
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
