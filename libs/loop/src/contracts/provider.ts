import { ROLE } from "@arden-hq/std/message-vocabulary"
import type {
  AssistantOutputPart,
  ChatMessage,
  InteractionMessage,
  MaybePromise,
  MessageOrigin,
  ProviderState,
  ProviderToolCall,
  ToolCall,
  UserMessage
} from "./messages.js"
import type { JsonSchema, ToolDeclaration, ToolSearch } from "./tools.js"

export const ToolChoice = {
  AUTO: "auto",
  NONE: "none",
  REQUIRED: "required"
} as const

export type ToolChoice = (typeof ToolChoice)[keyof typeof ToolChoice]

export const FinishReason = {
  STOP: "stop",
  TOOL_CALLS: "tool_calls",
  LENGTH: "length",
  CONTENT_FILTER: "content_filter"
} as const

export type FinishReason = (typeof FinishReason)[keyof typeof FinishReason]

export interface Usage {
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly cache_read_tokens: number
  readonly cache_write_tokens: number
  readonly cost: number | undefined
}

export const zeroUsage = (): Usage => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost: 0
})

const count = (value: number | undefined): number => value ?? 0

export const usageInputTokens = (usage: Partial<Usage>): number =>
  count(usage.prompt_tokens) + count(usage.cache_read_tokens) + count(usage.cache_write_tokens)

export const addCost = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined || right === undefined ? undefined : left + right

export const addUsage = (left: Usage, right: Partial<Usage>): Usage => ({
  prompt_tokens: count(left.prompt_tokens) + count(right.prompt_tokens),
  completion_tokens: count(left.completion_tokens) + count(right.completion_tokens),
  cache_read_tokens: count(left.cache_read_tokens) + count(right.cache_read_tokens),
  cache_write_tokens: count(left.cache_write_tokens) + count(right.cache_write_tokens),
  cost: addCost(left.cost, right.cost)
})

export const MODEL_STREAM_ITEM_TAG = {
  textDelta: "TextDelta",
  reasoningDelta: "ReasoningDelta",
  toolCallDelta: "ToolCallDelta",
  outputItemReady: "OutputItemReady",
  providerToolCall: "ProviderToolCall",
  providerStreamRetry: "ProviderStreamRetry",
  completed: "Completed"
} as const
export type ModelStreamItemTag = (typeof MODEL_STREAM_ITEM_TAG)[keyof typeof MODEL_STREAM_ITEM_TAG]

export const isCompletionResponse = (item: ModelStreamItem): item is CompletionResponse =>
  item._tag === MODEL_STREAM_ITEM_TAG.completed

export interface TextContentDelta {
  readonly _tag: typeof MODEL_STREAM_ITEM_TAG.textDelta
  readonly content: string
}

export interface ReasoningContentDelta {
  readonly _tag: typeof MODEL_STREAM_ITEM_TAG.reasoningDelta
  readonly content: string
}

export interface ToolCallStreamDelta {
  readonly _tag: typeof MODEL_STREAM_ITEM_TAG.toolCallDelta
  readonly index: number
  readonly tool_id?: string | null
  readonly name?: string | null
  readonly arguments_delta?: string | null
  readonly done?: boolean
}

export interface OutputItemReady {
  readonly _tag: typeof MODEL_STREAM_ITEM_TAG.outputItemReady
  readonly message: ProviderMessage
}

export interface ProviderToolCallDelta {
  readonly _tag: typeof MODEL_STREAM_ITEM_TAG.providerToolCall
  readonly call: ProviderToolCall
}

export interface ProviderStreamRetry {
  readonly _tag: typeof MODEL_STREAM_ITEM_TAG.providerStreamRetry
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs?: number
  readonly reason?: string
}

export interface ProviderMessage {
  readonly role: typeof ROLE.assistant
  readonly content: string | null
  readonly tool_calls: ReadonlyArray<ToolCall> | null
  readonly reasoning_content: string | null
  readonly provider_tool_calls?: ReadonlyArray<ProviderToolCall> | null
  readonly output_parts?: ReadonlyArray<AssistantOutputPart> | null
  readonly provider_state?: ProviderState
  readonly origin?: MessageOrigin
}

export interface CompletionResponse {
  readonly _tag: typeof MODEL_STREAM_ITEM_TAG.completed
  readonly continuation?: boolean
  readonly message: ProviderMessage
  readonly finish_reason: FinishReason | null
  readonly usage: Partial<Usage> & Pick<Usage, "completion_tokens">
  readonly model: string
}

export type ModelStreamItem =
  | TextContentDelta
  | ReasoningContentDelta
  | ToolCallStreamDelta
  | OutputItemReady
  | ProviderToolCallDelta
  | ProviderStreamRetry
  | CompletionResponse

export type ModelSource<A> =
  | Iterable<A>
  | AsyncIterable<A>
  | PromiseLike<Iterable<A> | AsyncIterable<A>>

export interface ResponseFormat {
  readonly name: string
  readonly schema: JsonSchema
}

export interface ModelProviderRequest {
  readonly steering?: { readonly take: () => Promise<ReadonlyArray<UserMessage>> }
  readonly messages: ReadonlyArray<ChatMessage>
  readonly renderInteraction: (message: InteractionMessage, form: InteractionForm) => string
  readonly model: string
  readonly maxOutputTokens?: number
  readonly tools: ReadonlyArray<ToolDeclaration>
  readonly deferredTools: ReadonlyArray<ToolDeclaration>
  readonly toolSearch?: ToolSearch
  readonly toolChoice: ToolChoice
  readonly reasoningEffort?: string
  readonly cacheScope?: string
  readonly responseFormat?: ResponseFormat
  readonly signal?: AbortSignal
}

export const MODEL_PROVIDER_PROTOCOL = 2

export interface ModelProvider {
  readonly protocolVersion: typeof MODEL_PROVIDER_PROTOCOL
  readonly openSession?: () => MaybePromise<ModelProviderSession>
  readonly capabilities?: (model: string) => MaybePromise<ModelCapabilities>
  readonly stream: (request: ModelProviderRequest) => ModelSource<ModelStreamItem>
}

export interface ModelProviderSession {
  readonly stream: ModelProvider["stream"]
  readonly close: () => MaybePromise<void>
}

export const DELIVERY_MODE = { native: "native", message: "message" } as const
export type DeliveryMode = (typeof DELIVERY_MODE)[keyof typeof DELIVERY_MODE]

export const STEERING_MODE = { native: "native", boundary: "boundary" } as const
export type SteeringMode = (typeof STEERING_MODE)[keyof typeof STEERING_MODE]

export const STRUCTURED_OUTPUT_SUPPORT = { none: "none", native: "native" } as const
export type StructuredOutputSupport =
  (typeof STRUCTURED_OUTPUT_SUPPORT)[keyof typeof STRUCTURED_OUTPUT_SUPPORT]

export const TOOL_SEARCH_MODE = { client: "client", none: "none" } as const
export type ToolSearchMode = (typeof TOOL_SEARCH_MODE)[keyof typeof TOOL_SEARCH_MODE]

export const REASONING_EFFORT = {
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra"
} as const
export type ReasoningEffort = (typeof REASONING_EFFORT)[keyof typeof REASONING_EFFORT]

export const INTERACTION_FORM = { native: "native", text: "text" } as const
export type InteractionForm = (typeof INTERACTION_FORM)[keyof typeof INTERACTION_FORM]

export interface ModelCapabilities {
  readonly agentMessages?: DeliveryMode
  readonly asyncTools?: DeliveryMode
  readonly steering?: SteeringMode
  readonly hostedTools: ReadonlyArray<string>
  readonly structuredOutput: StructuredOutputSupport
  readonly toolSearch?: ToolSearchMode
  readonly outputLimit?: "sent" | "omitted"
  readonly imageInput?: ImageInput
}

export interface ImageInput {
  readonly limits: ImageInputLimits | undefined
}

export interface ImageInputLimits {
  readonly patchSize: number
  readonly fitSide: number
  readonly fitPatches: number
  readonly maxPatches: number
}

export interface ModelRequest {
  readonly step: number
  readonly messages: ReadonlyArray<ChatMessage>
  readonly model: string
  readonly maxOutputTokens?: number
  readonly tools: ReadonlyArray<ToolDeclaration>
  readonly deferredTools: ReadonlyArray<ToolDeclaration>
  readonly toolChoice: ToolChoice
  readonly reasoningEffort?: string
  readonly cacheScope?: string
  readonly responseFormat?: ResponseFormat
  readonly previousResponse: CompletionResponse | null
  readonly compactionReplacement?: ReadonlyArray<ChatMessage>
  readonly contextOverflow?: true
}

export type ModelRequestNext = (request: ModelRequest) => MaybePromise<ModelRequest>
export type ModelRequestMiddleware = (
  request: ModelRequest,
  next: ModelRequestNext
) => MaybePromise<ModelRequest>
