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
  /**
   * What the provider says these requests cost, in US dollars, as it reported
   * it (OpenRouter's `usage.cost`; see `reportedCost`). Never computed from a
   * price table. Undefined when any request counted reported none (llama.cpp,
   * Codex, a response without usage): a sum with an unknown part is unknown,
   * so a reported total is always the whole spend, and a reported 0 (a free
   * model) stays apart from "not reported".
   */
  readonly cost: number | undefined
}

/** The usage of no request at all: nothing spent, so the cost is a known 0. */
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

/**
 * The sum of two reported costs (`Usage.cost`): unknown when either is. Every
 * total of reported costs, in the loop and its hosts, adds through this.
 */
export const addCost = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined || right === undefined ? undefined : left + right

/** Adds a response's usage; a response without a reported cost leaves the total's unknown. */
export const addUsage = (left: Usage, right: Partial<Usage>): Usage => ({
  prompt_tokens: count(left.prompt_tokens) + count(right.prompt_tokens),
  completion_tokens: count(left.completion_tokens) + count(right.completion_tokens),
  cache_read_tokens: count(left.cache_read_tokens) + count(right.cache_read_tokens),
  cache_write_tokens: count(left.cache_write_tokens) + count(right.cache_write_tokens),
  cost: addCost(left.cost, right.cost)
})

export interface TextContentDelta {
  readonly _tag: "TextDelta"
  readonly content: string
}

export interface ReasoningContentDelta {
  readonly _tag: "ReasoningDelta"
  readonly content: string
}

export interface ToolCallStreamDelta {
  readonly _tag: "ToolCallDelta"
  readonly index: number
  readonly tool_id?: string | null
  readonly name?: string | null
  readonly arguments_delta?: string | null
  readonly done?: boolean
}

/** A complete, immutable assistant output fragment, in response order.
 * The loop can persist it and execute its calls while streaming continues.
 * Adapters emitting fragments must cover the full terminal message, including
 * opaque replay state. Partial arguments remain ToolCallDelta presentation only. */
export interface OutputItemReady {
  readonly _tag: "OutputItemReady"
  readonly message: ProviderMessage
}

export interface ProviderToolCallDelta {
  readonly _tag: "ProviderToolCall"
  readonly call: ProviderToolCall
}

export interface ProviderStreamRetry {
  readonly _tag: "ProviderStreamRetry"
  /** 1-based transport attempt that just failed. */
  readonly attempt: number
  /** Total attempts the provider will make before the failure stands. */
  readonly maxAttempts: number
  /** Backoff the provider will sleep before re-streaming, in milliseconds. */
  readonly delayMs?: number
  /** Why the attempt failed, for logs. */
  readonly reason?: string
}

export interface ProviderMessage {
  readonly role: "assistant"
  readonly content: string | null
  readonly tool_calls: ReadonlyArray<ToolCall> | null
  readonly reasoning_content: string | null
  readonly provider_tool_calls?: ReadonlyArray<ProviderToolCall> | null
  /** Native output order normalized by the provider adapter. */
  readonly output_parts?: ReadonlyArray<AssistantOutputPart> | null
  readonly provider_state?: ProviderState
  readonly origin?: MessageOrigin
}

/** The terminal item of one provider response. */
export interface CompletionResponse {
  readonly _tag: "Completed"
  /** A provider-owned successor is pending; this response is not a final answer. */
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

/** JSON-Schema response format for structured output, carried to the provider. */
export interface ResponseFormat {
  readonly name: string
  readonly schema: JsonSchema
}

export interface ModelProviderRequest {
  /** Invocation-scoped pending user input. Adapters may poll only while generating. */
  readonly steering?: { readonly take: () => Promise<ReadonlyArray<UserMessage>> }
  readonly messages: ReadonlyArray<ChatMessage>
  readonly renderInteraction: (message: InteractionMessage) => string
  readonly model: string
  readonly maxOutputTokens?: number
  readonly tools: ReadonlyArray<ToolDeclaration>
  /**
   * The deferred catalog, loaded or not. It stays the same for a whole
   * conversation; loaded tools reach the model inside the conversation.
   */
  readonly deferredTools: ReadonlyArray<ToolDeclaration>
  /** Present when the route searches on the client and the catalog is not empty. */
  readonly toolSearch?: ToolSearch
  readonly toolChoice: ToolChoice
  readonly reasoningEffort?: string
  /** See `AgentConfigInput.cacheScope`; a provider without prompt caching ignores it. */
  readonly cacheScope?: string
  readonly responseFormat?: ResponseFormat
  readonly signal?: AbortSignal
}

export const MODEL_PROVIDER_PROTOCOL = 2

export interface ModelProvider {
  readonly protocolVersion: typeof MODEL_PROVIDER_PROTOCOL
  /** Allocate connection-local state for one agent invocation. */
  readonly openSession?: () => MaybePromise<ModelProviderSession>
  /** Optional native features, resolved for the actual model/endpoint route. */
  readonly capabilities?: (model: string) => MaybePromise<ModelCapabilities>
  readonly stream: (request: ModelProviderRequest) => ModelSource<ModelStreamItem>
}

export interface ModelProviderSession {
  readonly stream: ModelProvider["stream"]
  readonly close: () => MaybePromise<void>
}

export interface ModelCapabilities {
  readonly agentMessages?: "native" | "message"
  readonly asyncTools?: "native" | "message"
  readonly steering?: "native" | "boundary"
  readonly hostedTools: ReadonlyArray<string>
  /**
   * `native` — the provider constrains the final text to `responseFormat`
   * (the host supplies a schema its dialect accepts); `none` — the route
   * cannot, and a run with `output` fails before inference.
   */
  readonly structuredOutput: "none" | "native"
  /**
   * `client` — the provider declares the request's `toolSearch` and answers
   * the model's search calls with it, loading found tools into the
   * conversation; `none` (the default) — the loop declares every tool.
   */
  readonly toolSearch?: "client" | "none"
  /**
   * Whether the route sends `ModelRequest.maxOutputTokens` to the server.
   * `omitted` — it never does (the Codex backend refuses the field), so the
   * server's own limit applies and a request's limit cannot cut an answer
   * short; absent or `sent` — it does.
   */
  readonly outputLimit?: "sent" | "omitted"
  /** Present when the route takes images; absent, the host sends it none. */
  readonly imageInput?: ImageInput
}

/** A route that takes images. */
export interface ImageInput {
  /**
   * How the route measures and bounds an image, where it states that
   * (OpenAI's patch limits); the host shrinks each image to them. `undefined`
   * — the route states none (llama.cpp's projector resizes an image itself;
   * OpenRouter's limits differ by upstream), so the host sends each image at
   * its stored size, converted only to PNG or JPEG, rather than to limits it
   * would have to make up.
   */
  readonly limits: ImageInputLimits | undefined
}

/** How a route measures and bounds an input image, in `patchSize`-pixel square patches. */
export interface ImageInputLimits {
  readonly patchSize: number
  /** Images are shrunk (aspect kept) to at most this longest side before sending. */
  readonly fitSide: number
  /** ...and to at most this many patches. */
  readonly fitPatches: number
  /** One image over this many patches fails the whole request. */
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
  /** See `AgentConfigInput.cacheScope`; a provider without prompt caching ignores it. */
  readonly cacheScope?: string
  readonly responseFormat?: ResponseFormat
  readonly previousResponse: CompletionResponse | null
  /** The only middleware field allowed to persist a canonical history projection. */
  readonly compactionReplacement?: ReadonlyArray<ChatMessage>
  /**
   * Set when the provider refused this step's request as longer than its context window. A
   * middleware that shortens the history in answer returns the request without this field; while
   * it is still set after the middlewares, the refusal stands and the run fails with it.
   */
  readonly contextOverflow?: true
}

export type ModelRequestNext = (request: ModelRequest) => MaybePromise<ModelRequest>
export type ModelRequestMiddleware = (
  request: ModelRequest,
  next: ModelRequestNext
) => MaybePromise<ModelRequest>
