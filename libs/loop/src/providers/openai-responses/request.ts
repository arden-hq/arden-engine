import { ROLE } from "@arden-hq/std/message-vocabulary"
import {
  CONTENT_BLOCK_TYPE,
  type AssistantMessage,
  type ChatMessage,
  type ProviderToolCall
} from "../../contracts/messages.js"
import type { ToolDeclaration, ToolSearch } from "../../contracts/tools.js"
import {
  DELIVERY_MODE,
  INTERACTION_FORM,
  REASONING_EFFORT,
  ToolChoice,
  type DeliveryMode,
  type ModelCapabilities,
  type ModelProviderRequest,
  type ReasoningEffort
} from "../../contracts/provider.js"
import {
  contextBlockText,
  isImageMediaType,
  isToolSearchCall,
  MISSING_TOOL_OUTPUT,
  orderToolHistory,
  type ToolHistoryBatch,
  type ToolHistoryWire,
  isAgentMail,
  projectToolHistory,
  rendersAsText
} from "../kit/index.js"
import { PROVIDER_ERROR_CODE } from "../../errors.js"
import { OpenAiResponsesProviderError } from "./errors.js"
import { API, asRecord, RESPONSE_ITEM_TYPE, WEB_SEARCH_TOOL_NAME, type InputItem } from "./items.js"
import { responseItems } from "./stored-items.js"
import {
  clientToolSearchTool,
  functionTool,
  namespacedTools,
  RESPONSES_TOOL_TYPE,
  type ClientToolSearchTool,
  type FunctionTool
} from "./tools.js"

interface HostedWebSearchTool {
  readonly type: typeof RESPONSES_TOOL_TYPE.webSearch
  readonly external_web_access: true
}

type ResponsesTool = FunctionTool | HostedWebSearchTool | ClientToolSearchTool

export interface ResponsesPayload {
  readonly model: string
  readonly input: ReadonlyArray<InputItem>
  readonly include: ReadonlyArray<string>
  readonly stream: true
  readonly store: false
  readonly parallel_tool_calls: true
  readonly instructions?: string
  readonly tools?: ReadonlyArray<ResponsesTool>
  readonly tool_choice?: string
  readonly max_output_tokens?: number
  readonly reasoning?: { readonly effort: string; readonly summary: "detailed" }
  readonly prompt_cache_key?: string
  readonly text?: {
    readonly format: {
      readonly type: "json_schema"
      readonly name: string
      readonly schema: Readonly<Record<string, unknown>>
      readonly strict: true
    }
  }
}

const REASONING_EFFORTS: ReadonlySet<string> = new Set<ReasoningEffort>(
  Object.values(REASONING_EFFORT)
)

const decodeTools = (
  declarations: ReadonlyArray<ToolDeclaration>
): { readonly tools: ReadonlyArray<ResponsesTool>; readonly hasWebSearch: boolean } => {
  const tools: Array<ResponsesTool> = []
  let hasWebSearch = false
  for (const tool of declarations) {
    if (tool.hosted !== true) {
      tools.push(functionTool(tool))
      continue
    }
    if (tool.name !== WEB_SEARCH_TOOL_NAME) {
      throw new OpenAiResponsesProviderError("The tool catalog contains an unsupported hosted tool")
    }
    if (hasWebSearch) {
      throw new OpenAiResponsesProviderError(
        "The tool catalog contains duplicate hosted web search tools"
      )
    }
    hasWebSearch = true
    tools.push({ type: "web_search", external_web_access: true })
  }
  return { tools, hasWebSearch }
}

const textContent = (message: ChatMessage): string => {
  if (
    typeof message.content === "string" ||
    message.content === null ||
    message.content === undefined
  ) {
    return message.content ?? ""
  }
  throw new OpenAiResponsesProviderError(
    "OpenAI Responses currently supports text message content only"
  )
}

const userContent = (message: ChatMessage): string | ReadonlyArray<InputItem> => {
  if (
    typeof message.content === "string" ||
    message.content === null ||
    message.content === undefined
  ) {
    return message.content ?? ""
  }
  return message.content.map((value) => {
    const block = asRecord(value)
    if (block?.type === CONTENT_BLOCK_TYPE.text && typeof block.text === "string") {
      return { type: "input_text", text: block.text }
    }
    const context = contextBlockText(block)
    if (context !== undefined) return { type: "input_text", text: context }
    if (
      block?.type === CONTENT_BLOCK_TYPE.image &&
      isImageMediaType(block.media_type) &&
      typeof block.data === "string" &&
      block.data.length > 0
    ) {
      return {
        type: "input_image",
        image_url: `data:${block.media_type};base64,${block.data}`
      }
    }
    throw new OpenAiResponsesProviderError("OpenAI Responses received unsupported user content")
  })
}

export interface ResponsesRoute {
  readonly agentMessages: DeliveryMode
  readonly asyncTools: DeliveryMode
}

export const responsesRoute = (capabilities: ModelCapabilities): ResponsesRoute => ({
  agentMessages: capabilities.agentMessages ?? DELIVERY_MODE.message,
  asyncTools: capabilities.asyncTools ?? DELIVERY_MODE.message
})

const convertMessages = (
  stored: ReadonlyArray<ChatMessage>,
  renderInteraction: ModelProviderRequest["renderInteraction"],
  toolSearch: ToolSearch | undefined,
  asyncTools: ReadonlySet<string>,
  route: ResponsesRoute
): { readonly instructions?: string; readonly input: ReadonlyArray<InputItem> } => {
  const instructions: Array<string> = []
  const batches: Array<ToolHistoryBatch<InputItem>> = []
  const messages = projectToolHistory({
    messages: stored,
    nativeAsync: route.asyncTools === DELIVERY_MODE.native
  })

  for (const message of messages) {
    if (message.role === ROLE.system) {
      const content = textContent(message)
      if (content.length > 0) instructions.push(content)
      continue
    }
    if (
      message.role === ROLE.developer &&
      toolSearch !== undefined &&
      message.loaded_tools?.length
    ) {
      batches.push({
        items: clientSearchExchange(
          `tool-load-${message.message_id ?? message.loaded_tools.join(",")}`,
          { query: `select:${message.loaded_tools.join(",")}` },
          message.loaded_tools,
          toolSearch
        ),
        deferWhileCallsPending: true
      })
      continue
    }
    if (message.role === ROLE.developer) {
      const content = textContent(message)
      if (content.length > 0) {
        batches.push({
          items: [
            {
              type: "message",
              role: ROLE.developer,
              content: [{ type: "input_text", text: content }]
            }
          ],
          deferWhileCallsPending: true
        })
      }
      continue
    }
    if (message.role === ROLE.interaction) {
      if (
        route.agentMessages === DELIVERY_MODE.native &&
        isAgentMail(message) &&
        message.to !== undefined
      ) {
        batches.push({
          items: [
            {
              type: "agent_message",
              author: message.from.id,
              recipient: message.to.id,
              content: [
                { type: "input_text", text: renderInteraction(message, INTERACTION_FORM.native) }
              ]
            }
          ],
          deferWhileCallsPending: false
        })
        continue
      }
      batches.push({
        items: [
          {
            role: ROLE.user,
            content: rendersAsText(message)
              ? renderInteraction(message, INTERACTION_FORM.text)
              : userContent(message)
          }
        ],
        deferWhileCallsPending: !rendersAsText(message)
      })
      continue
    }
    if (message.role === ROLE.user) {
      batches.push({
        items: [{ role: ROLE.user, content: userContent(message) }],
        deferWhileCallsPending: true
      })
      continue
    }
    if (message.role === ROLE.tool) {
      batches.push({
        items: [
          {
            type: "function_call_output",
            call_id: message.tool_call_id,
            output: textContent(message),
            status: "completed"
          }
        ],
        deferWhileCallsPending: false
      })
      continue
    }

    const replay = responseItems(message, asyncTools)
    const providerCalls = message.provider_tool_calls ?? []
    if (!Array.isArray(providerCalls)) {
      throw new OpenAiResponsesProviderError("Stored provider tool history is invalid")
    }
    if (replay === undefined && providerCalls.length > 0 && writtenHere(message)) {
      throw new OpenAiResponsesProviderError(
        "Stored provider tool history requires matching OpenAI response items"
      )
    }

    if (replay !== undefined) {
      batches.push({ items: replay, deferWhileCallsPending: false })
      continue
    }
    const content = textContent(message)
    batches.push({
      items: [
        ...(content.length > 0 ? [{ role: ROLE.assistant, content }] : []),
        ...foreignToolSearches(providerCalls, toolSearch),
        ...(message.tool_calls ?? []).map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          ...(call.async === true ? { async: true } : {}),
          status: "completed"
        }))
      ],
      deferWhileCallsPending: false
    })
  }

  const input = orderToolHistory(batches, FUNCTION_CALL_HISTORY)
  const joined = instructions.join("\n\n")
  return {
    ...(joined.length === 0 ? {} : { instructions: joined }),
    input
  }
}

const writtenHere = (message: AssistantMessage): boolean =>
  message.origin === undefined || message.origin.api === API

const clientSearchExchange = (
  callId: string,
  args: unknown,
  names: ReadonlyArray<string>,
  toolSearch: ToolSearch
): ReadonlyArray<InputItem> => [
  {
    type: "tool_search_call",
    call_id: callId,
    execution: "client",
    status: "completed",
    arguments: args
  },
  {
    type: "tool_search_output",
    call_id: callId,
    execution: "client",
    status: "completed",
    tools: namespacedTools(toolSearch.lookup(names))
  }
]

const foreignToolSearches = (
  calls: ReadonlyArray<ProviderToolCall>,
  toolSearch: ToolSearch | undefined
): ReadonlyArray<InputItem> =>
  toolSearch === undefined
    ? []
    : calls
        .filter(isToolSearchCall)
        .flatMap((call) =>
          clientSearchExchange(
            call.id,
            call.arguments ?? {},
            call.loaded_tool_names ?? [],
            toolSearch
          )
        )

const FUNCTION_CALL_HISTORY: ToolHistoryWire<InputItem> = {
  name: "OpenAI tool history",
  calls: (item) =>
    item.type === RESPONSE_ITEM_TYPE.functionCall
      ? [{ id: item.call_id, async: item.async === true }]
      : [],
  answers: (item) =>
    item.type === RESPONSE_ITEM_TYPE.functionCallOutput ? { id: item.call_id } : undefined,
  missingOutput: (callId) => ({
    type: "function_call_output",
    call_id: callId,
    output: MISSING_TOOL_OUTPUT,
    status: "completed"
  }),
  fail: (message) => new OpenAiResponsesProviderError(message)
}

export const makePayload = (
  request: ModelProviderRequest,
  modelPrefix: string,
  defaultInstructions: string | undefined,
  route: ResponsesRoute
): ResponsesPayload => {
  try {
    return buildPayload(request, modelPrefix, defaultInstructions, route)
  } catch (error) {
    if (
      error instanceof OpenAiResponsesProviderError &&
      error.code === PROVIDER_ERROR_CODE.providerError
    ) {
      throw new OpenAiResponsesProviderError(error.message, PROVIDER_ERROR_CODE.requestInvalid)
    }
    throw error
  }
}

const buildPayload = (
  request: ModelProviderRequest,
  modelPrefix: string,
  defaultInstructions: string | undefined,
  route: ResponsesRoute
): ResponsesPayload => {
  const asyncTools = new Set(
    [...request.tools, ...request.deferredTools].flatMap((tool) =>
      tool.async === true ? [tool.name] : []
    )
  )
  const history = convertMessages(
    request.messages,
    request.renderInteraction,
    request.toolSearch,
    asyncTools,
    route
  )
  const catalog = decodeTools(request.tools)
  const tools =
    request.toolSearch === undefined
      ? catalog.tools
      : [...catalog.tools, clientToolSearchTool(request.toolSearch)]
  if (request.toolChoice === ToolChoice.REQUIRED && tools.length === 0) {
    throw new OpenAiResponsesProviderError(
      "A required tool choice needs at least one function tool"
    )
  }
  const model =
    modelPrefix.length > 0 && request.model.startsWith(modelPrefix)
      ? request.model.slice(modelPrefix.length)
      : request.model
  if (model.trim().length === 0) {
    throw new OpenAiResponsesProviderError("The OpenAI model ID must not be empty")
  }
  if (request.reasoningEffort !== undefined && !REASONING_EFFORTS.has(request.reasoningEffort)) {
    throw new OpenAiResponsesProviderError("The OpenAI reasoning effort is not supported")
  }
  const instructions = history.instructions ?? defaultInstructions
  return {
    model,
    input: history.input,
    include: [
      "reasoning.encrypted_content",
      ...(catalog.hasWebSearch ? ["web_search_call.action.sources"] : [])
    ],
    stream: true,
    store: false,
    parallel_tool_calls: true,
    ...(instructions === undefined ? {} : { instructions }),
    ...(tools.length === 0 ? {} : { tools, tool_choice: request.toolChoice }),
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: request.maxOutputTokens }),
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: request.reasoningEffort, summary: "detailed" } }),
    ...(request.cacheScope === undefined ? {} : { prompt_cache_key: request.cacheScope }),
    ...(request.responseFormat === undefined
      ? {}
      : {
          text: {
            format: {
              type: "json_schema" as const,
              name: request.responseFormat.name,
              schema: request.responseFormat.schema,
              strict: true as const
            }
          }
        })
  }
}
