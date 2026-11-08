import type { ChatMessage } from "../../contracts/messages.js"
import type { ToolDeclaration, ToolSearch } from "../../contracts/tools.js"
import type { ModelProviderRequest } from "../../contracts/provider.js"
import { OpenAiResponsesProviderError } from "./errors.js"
import { validateFunctionCallHistory, type InputBatch } from "./history.js"
import { asRecord, WEB_SEARCH_TOOL_NAME, type InputItem } from "./items.js"
import { responseItems } from "./stored-items.js"
import {
  clientToolSearchTool,
  functionTool,
  namespacedTools,
  type ClientToolSearchTool,
  type FunctionTool
} from "./tools.js"

interface HostedWebSearchTool {
  readonly type: "web_search"
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

const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
])

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
    if (block?.type === "text" && typeof block.text === "string") {
      return { type: "input_text", text: block.text }
    }
    if (
      block?.type === "context" &&
      typeof block.content_type === "string" &&
      (block.content === undefined || block.content === null || typeof block.content === "string")
    ) {
      const metadata =
        block.metadata === undefined || block.metadata === null ? {} : asRecord(block.metadata)
      if (metadata === null || Object.values(metadata).some((value) => typeof value !== "string")) {
        throw new OpenAiResponsesProviderError("OpenAI Responses received unsupported user content")
      }
      const attrs = Object.entries(metadata)
        .map(([key, value]) => `${key}="${value as string}"`)
        .join(" ")
      const tag = `${block.content_type}${attrs.length === 0 ? "" : ` ${attrs}`}`
      return {
        type: "input_text",
        text:
          typeof block.content === "string" && block.content.length > 0
            ? `<${tag}>\n${block.content}\n</${block.content_type}>`
            : `<${tag} />`
      }
    }
    if (
      block?.type === "image" &&
      (block.media_type === "image/png" || block.media_type === "image/jpeg") &&
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

const convertMessages = (
  messages: ReadonlyArray<ChatMessage>,
  renderInteraction: ModelProviderRequest["renderInteraction"],
  toolSearch: ToolSearch | undefined,
  asyncTools: ReadonlySet<string>
): { readonly instructions?: string; readonly input: ReadonlyArray<InputItem> } => {
  const instructions: Array<string> = []
  const batches: Array<InputBatch> = []

  for (const message of messages) {
    if (message.role === "system") {
      const content = textContent(message)
      if (content.length > 0) instructions.push(content)
      continue
    }
    if (message.role === "developer" && toolSearch !== undefined && message.loaded_tools?.length) {
      const callId = `tool-load-${message.message_id ?? message.loaded_tools.join(",")}`
      batches.push({
        items: [
          {
            type: "tool_search_call",
            call_id: callId,
            execution: "client",
            status: "completed",
            arguments: { query: `select:${message.loaded_tools.join(",")}` }
          },
          {
            type: "tool_search_output",
            call_id: callId,
            execution: "client",
            status: "completed",
            tools: namespacedTools(toolSearch.lookup(message.loaded_tools))
          }
        ],
        deferWhileCallsPending: true
      })
      continue
    }
    if (message.role === "developer") {
      const content = textContent(message)
      if (content.length > 0) {
        batches.push({
          items: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: content }]
            }
          ],
          deferWhileCallsPending: true
        })
      }
      continue
    }
    if (message.role === "user") {
      if (message.async_tool_launch !== undefined) continue
      if (message.interaction !== undefined) {
        batches.push({
          items: [
            {
              type: "agent_message",
              author: message.interaction.from.id,
              recipient: message.interaction.to.id,
              content: [{ type: "input_text", text: renderInteraction(message.interaction) }]
            }
          ],
          deferWhileCallsPending: false
        })
        continue
      }
      batches.push({
        items: [{ role: "user", content: userContent(message) }],
        deferWhileCallsPending: true
      })
      continue
    }
    if (message.role === "tool") {
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
    if ("provider_tool_calls" in message) {
      const calls = message.provider_tool_calls
      if (calls !== null && !Array.isArray(calls)) {
        throw new OpenAiResponsesProviderError("Stored provider tool history is invalid")
      }
      if (replay === undefined && Array.isArray(calls) && calls.length > 0) {
        throw new OpenAiResponsesProviderError(
          "Stored provider tool history requires matching OpenAI response items"
        )
      }
    }

    if (replay !== undefined) {
      batches.push({ items: replay, deferWhileCallsPending: false })
      continue
    }
    const content = textContent(message)
    batches.push({
      items: [
        ...(content.length > 0 ? [{ role: "assistant", content }] : []),
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

  const input = validateFunctionCallHistory(batches)
  const joined = instructions.join("\n\n")
  return {
    ...(joined.length === 0 ? {} : { instructions: joined }),
    input
  }
}

/**
 * The request body for one model step. A request this adapter cannot build
 * from the stored history or the tool catalog is Arden's own defect, never
 * the person's: it fails as `request_invalid`, like a request OpenAI refuses.
 */
export const makePayload = (
  request: ModelProviderRequest,
  modelPrefix: string,
  defaultInstructions: string | undefined
): ResponsesPayload => {
  try {
    return buildPayload(request, modelPrefix, defaultInstructions)
  } catch (error) {
    if (error instanceof OpenAiResponsesProviderError && error.code === "provider_error") {
      throw new OpenAiResponsesProviderError(error.message, "request_invalid")
    }
    throw error
  }
}

const buildPayload = (
  request: ModelProviderRequest,
  modelPrefix: string,
  defaultInstructions: string | undefined
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
    asyncTools
  )
  const catalog = decodeTools(request.tools)
  const tools =
    request.toolSearch === undefined
      ? catalog.tools
      : [...catalog.tools, clientToolSearchTool(request.toolSearch)]
  if (request.toolChoice === "required" && tools.length === 0) {
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
