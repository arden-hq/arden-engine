import { ROLE } from "@arden-hq/std/message-vocabulary"
import { isRecord } from "@arden-hq/std/json"

import {
  CONTENT_BLOCK_TYPE,
  isToolCallPart,
  type AssistantMessage,
  type ChatMessage,
  type JsonObject,
  type JsonValue,
  type ProviderToolCall
} from "../../contracts/messages.js"
import {
  INTERACTION_FORM,
  ToolChoice,
  type ModelProviderRequest
} from "../../contracts/provider.js"
import { loadedToolNames, type ToolDeclaration } from "../../contracts/tools.js"
import {
  contextBlockText,
  isImageMediaType,
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
import {
  CACHE_CONTROL_STYLE,
  COMPAT_STRUCTURED_OUTPUT,
  REASONING_EFFORT_STYLE,
  TOOL_CHOICE_NONE,
  type ChatCompletionsCompat
} from "./compat.js"
import { PROVIDER_ERROR_CODE } from "../../errors.js"
import { ChatCompletionsProviderError } from "./errors.js"

export const API = "chat-completions"

interface CacheControl {
  readonly type: "ephemeral"
}

const CONTENT_PART_TYPE = { text: "text", imageUrl: "image_url" } as const

type ContentPart =
  | {
      readonly type: typeof CONTENT_PART_TYPE.text
      readonly text: string
      readonly cache_control?: CacheControl
    }
  | {
      readonly type: typeof CONTENT_PART_TYPE.imageUrl
      readonly image_url: { readonly url: string }
    }

type Content = string | ReadonlyArray<ContentPart>

interface WireToolCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

type WireMessage =
  | {
      readonly role: typeof ROLE.system | typeof ROLE.developer | typeof ROLE.user
      readonly content: Content
    }
  | {
      readonly role: typeof ROLE.assistant
      readonly content: Content
      readonly tool_calls?: ReadonlyArray<WireToolCall>
      readonly reasoning_details?: ReadonlyArray<JsonValue>
    }
  | { readonly role: typeof ROLE.tool; readonly tool_call_id: string; readonly content: Content }

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

export interface PayloadContext {
  readonly providerId: string
  readonly label: string
  readonly compat: ChatCompletionsCompat
  readonly extraBody: JsonObject
}

const EPHEMERAL: CacheControl = { type: "ephemeral" }

export const makePayload = (
  request: ModelProviderRequest,
  context: PayloadContext
): ChatCompletionsPayload => {
  try {
    return buildPayload(request, context)
  } catch (error) {
    if (
      error instanceof ChatCompletionsProviderError &&
      error.code === PROVIDER_ERROR_CODE.providerError
    ) {
      throw new ChatCompletionsProviderError(error.message, PROVIDER_ERROR_CODE.requestInvalid)
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
  if (
    request.responseFormat !== undefined &&
    compat.structuredOutput === COMPAT_STRUCTURED_OUTPUT.none
  )
    throw fail("route does not constrain output to a JSON schema")
  const tools = declaredTools(request).map((tool) => functionTool(tool, fail))
  const names = tools.map((tool) => tool.function.name)
  const repeated = names.find((name, index) => names.indexOf(name) !== index)
  if (repeated !== undefined) throw fail(`declares the tool ${repeated} twice`)
  if (request.toolChoice === ToolChoice.REQUIRED && tools.length === 0)
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
    request.toolChoice === ToolChoice.AUTO ||
    (request.toolChoice === ToolChoice.NONE &&
      compat.toolChoiceNone === TOOL_CHOICE_NONE.unenforced)
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
  return compat.cacheControl === CACHE_CONTROL_STYLE.anthropic ? withCacheBreakpoints(body) : body
}

const reasoningFields = (
  effort: string | undefined,
  compat: ChatCompletionsCompat
): Readonly<Record<string, unknown>> => {
  if (effort === undefined) return {}
  switch (compat.reasoningEffort) {
    case REASONING_EFFORT_STYLE.reasoningEffort:
      return { reasoning_effort: effort }
    case REASONING_EFFORT_STYLE.openrouter:
      return { reasoning: { effort } }
    case REASONING_EFFORT_STYLE.none:
      return {}
  }
}

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

const historyWire = (label: string): ToolHistoryWire<WireMessage> => ({
  name: "tool history",
  calls: (item) =>
    item.role === ROLE.assistant
      ? (item.tool_calls ?? []).map((call) => ({ id: call.id, async: false }))
      : [],
  answers: (item) => (item.role === ROLE.tool ? { id: item.tool_call_id } : undefined),
  missingOutput: (callId) => ({
    role: ROLE.tool,
    tool_call_id: callId,
    content: MISSING_TOOL_OUTPUT
  }),
  fail: (message) => new ChatCompletionsProviderError(`${label}: ${message}`)
})

const convertMessages = (
  request: ModelProviderRequest,
  context: PayloadContext
): ReadonlyArray<WireMessage> => {
  const { compat, label } = context
  const messages = projectToolHistory({ messages: request.messages, nativeAsync: false })
  const leading = messages.findIndex((message) => message.role !== ROLE.system)
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
        case ROLE.system:
        case ROLE.developer: {
          const content = textContent(message, label)
          return content.length === 0
            ? []
            : [{ items: [{ role: compat.systemRole, content }], deferWhileCallsPending: true }]
        }
        case ROLE.interaction:
          return [
            {
              items: [
                {
                  role: ROLE.user,
                  content: rendersAsText(message)
                    ? request.renderInteraction(message, INTERACTION_FORM.text)
                    : userContent(message.content, compat, label)
                }
              ],
              deferWhileCallsPending: !rendersAsText(message)
            }
          ]
        case ROLE.user: {
          return [
            {
              items: [{ role: ROLE.user, content: userContent(message.content, compat, label) }],
              deferWhileCallsPending: true
            }
          ]
        }
        case ROLE.tool:
          return [
            {
              items: [
                {
                  role: ROLE.tool,
                  tool_call_id: message.tool_call_id,
                  content: textContent(message, label)
                }
              ],
              deferWhileCallsPending: false
            }
          ]
        case ROLE.assistant: {
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

const searchesOf = (message: AssistantMessage): ReadonlyArray<ProviderToolCall> =>
  (message.provider_tool_calls ?? []).filter(isToolSearchCall)

const searchResultItem = (call: ProviderToolCall): WireMessage => ({
  role: ROLE.tool,
  tool_call_id: call.id,
  content: call.result === undefined || call.result.length === 0 ? MISSING_TOOL_OUTPUT : call.result
})

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
  const ordered = (message.output_parts ?? [])
    .filter(isToolCallPart)
    .map((part) => part.tool_call_id)
  const calls = [
    ...new Set([...ordered.filter((id) => written.has(id)), ...written.keys()])
  ].flatMap((id) => {
    const call = written.get(id)
    return call === undefined ? [] : [call]
  })
  const details = replayedReasoningDetails(message, route)
  if (content.length === 0 && calls.length === 0 && details === undefined) return undefined
  return {
    role: ROLE.assistant,
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
    if (isRecord(block) && block.type === CONTENT_BLOCK_TYPE.text && typeof block.text === "string")
      return { type: "text", text: block.text }
    const context = contextBlockText(block)
    if (context !== undefined) return { type: "text", text: context }
    if (isRecord(block) && block.type === CONTENT_BLOCK_TYPE.image) {
      if (!compat.imageInput) return { type: "text", text: IMAGE_OMITTED }
      if (
        isImageMediaType(block.media_type) &&
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

const withCacheBreakpoints = (body: ChatCompletionsPayload): ChatCompletionsPayload => {
  const tools = body.tools?.map((tool, index, all) =>
    index === all.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool
  )
  const firstInstruction = body.messages
    .flatMap((message, index) =>
      message.role === ROLE.system || message.role === ROLE.developer ? [index] : []
    )
    .at(0)
  const lastTurn = body.messages
    .flatMap((message, index) =>
      (message.role === ROLE.user ||
        message.role === ROLE.assistant ||
        message.role === ROLE.tool) &&
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
  const last = content
    .flatMap((part, index) => (part.type === CONTENT_PART_TYPE.text ? [index] : []))
    .at(-1)
  if (last === undefined) return undefined
  return content.map((part, index) =>
    index === last && part.type === CONTENT_PART_TYPE.text
      ? { ...part, cache_control: EPHEMERAL }
      : part
  )
}
