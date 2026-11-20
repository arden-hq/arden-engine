export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }
export type JsonObject = Readonly<Record<string, JsonValue>>
export type Metadata = Readonly<Record<string, unknown>>

export type MaybePromise<A> = A | PromiseLike<A>

// Standard Schema v1 — vendored type-only interface (https://standardschema.dev).
// Any conforming schema library (zod v4, effect Schema, valibot) satisfies it.

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>
    readonly types?: Types<Input, Output> | undefined
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult

  export interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }

  export interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined
  }

  export interface PathSegment {
    readonly key: PropertyKey
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }

  export type InferInput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"]
  export type InferOutput<S extends StandardSchemaV1> = NonNullable<
    S["~standard"]["types"]
  >["output"]
}

export interface TextContent {
  readonly type: "text"
  readonly text: string
}

export interface ImageContent {
  readonly type: "image"
  readonly media_type: string
  readonly data: string
}

export interface AudioContent {
  readonly type: "audio"
  readonly media_type: string
  readonly data: string
}

export interface ContextContent {
  readonly type: "context"
  readonly content_type: string
  readonly content?: string | null
  readonly metadata?: Readonly<Record<string, string>> | null
}

export type ContentBlock = TextContent | ImageContent | AudioContent | ContextContent
export type ModelContentBlock = ContentBlock

export interface FunctionCall {
  readonly name: string
  readonly arguments: string
}

export interface ToolCall {
  /** Native wire flag, preserved on replay. */
  readonly async?: boolean
  readonly id: string
  readonly type: "function"
  readonly function: FunctionCall
  readonly started_at?: number
  readonly parent_id?: string | null
  /** Sanitized display title the model wrote through the host's opt-in
   *  argument (`CreateToolsetOptions.displayTitle`); never a tool argument.
   *  Host fields from `AgentOptions.persistHost` ride beside it. */
  readonly display_title?: string
}

export type AssistantTextPhase = "commentary" | "final_answer"

export const INTERACTION_SOURCES = ["agent", "workflow", "tool", "automation", "harness"] as const
export type InteractionSource = (typeof INTERACTION_SOURCES)[number]

export interface InteractionActor extends JsonObject {
  readonly source: InteractionSource
  readonly id: string
  readonly name?: string
}

export interface InteractionRecipient extends JsonObject {
  readonly source: "agent"
  readonly id: string
}

export interface InteractionReference extends JsonObject {
  readonly type: "message" | "run" | "tool_call" | "workflow"
  readonly id: string
}

/** Immutable model-facing snapshot of the message a human replied to. */
export interface ReplyContext extends JsonObject {
  readonly messageId: string
  readonly role: "user" | "assistant"
  readonly content: string
}

export const INTERACTION_KINDS = [
  "message",
  "assignment",
  "instruction",
  "event",
  "completion"
] as const
export type InteractionKind = (typeof INTERACTION_KINDS)[number]

/** `interrupted`: the sender stopped because the host restarted. */
export const INTERACTION_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
  "needs_attention",
  "interrupted"
] as const
export type InteractionOutcome = (typeof INTERACTION_OUTCOMES)[number]

export type AssistantOutputPart =
  | {
      readonly type: "reasoning"
      readonly text: string
    }
  | {
      readonly type: "text"
      readonly text: string
      readonly phase?: AssistantTextPhase
    }
  | {
      readonly type: "tool_call"
      readonly tool_call_id: string
      readonly execution: "runtime" | "provider"
    }

/**
 * The fields the loop itself reads on any stored message. Everything else a
 * host keeps on a message rides the open record and round-trips untouched.
 */
interface MessageFields extends Metadata {
  readonly message_id?: string
  readonly client_id?: string
}

export interface AsyncToolLaunch {
  readonly call_id: string
}

export interface SystemMessage extends MessageFields {
  readonly role: "system"
  readonly content: string | ReadonlyArray<Metadata>
}

/** Current high-priority context that belongs in the request timeline, not the stable base prompt. */
interface DeveloperMessage extends MessageFields {
  readonly role: "developer"
  readonly content: string | ReadonlyArray<Metadata>
  /**
   * Deferred tools that stay loaded after a compaction removed the history
   * that loaded them. A provider renders them in its own form; `content`
   * is the plain-text fallback.
   */
  readonly loaded_tools?: ReadonlyArray<string>
  /**
   * Deferred tools that left the catalog at this point in the conversation.
   * They no longer count as loaded; if one returns, a search loads it again.
   */
  readonly removed_tools?: ReadonlyArray<string>
}

export interface UserMessage extends MessageFields {
  readonly role: "user"
  readonly content?: string | null | ReadonlyArray<Metadata>
  /** One quoted message, or several. Stored histories hold either form; read it
   *  through `replyContexts`. */
  readonly replyTo?: ReplyContext | ReadonlyArray<ReplyContext>
}

export type InteractionMessage = MessageFields & {
  readonly role: "interaction"
  readonly from: InteractionActor
  readonly to?: InteractionRecipient
  readonly content: string | ReadonlyArray<Metadata>
  readonly preview?: string
  readonly caused_by?: InteractionReference
  /** On the correction `hooks.checkFinalText` appended: the assistant records
   *  of the answer it sent back. Durable with the history, so a host that
   *  resumes the run knows the check already ran and what it replaced. */
  readonly rejected_message_ids?: ReadonlyArray<string>
} & (
    | { readonly kind: Exclude<InteractionKind, "completion"> }
    | { readonly kind: "completion"; readonly outcome: InteractionOutcome }
  )

export interface AssistantMessage extends MessageFields {
  readonly role: "assistant"
  readonly content?: string | null | ReadonlyArray<Metadata>
  readonly tool_calls?: ReadonlyArray<ToolCall>
  /** Calls the provider executed upstream, persisted with their results. */
  readonly provider_tool_calls?: ReadonlyArray<ProviderToolCall> | null
  readonly reasoning_content?: string | null
  /** Provider-neutral presentation order for this model turn. */
  readonly output_parts?: ReadonlyArray<AssistantOutputPart>
  /** Opaque replay state, keyed by the provider that wrote it. */
  readonly provider_state?: ProviderState
  /** Who produced this turn; adapters read it to decide whether `provider_state` replays. */
  readonly origin?: MessageOrigin
}

export interface ToolResultMessage extends MessageFields {
  readonly role: "tool"
  readonly tool_call_id: string
  readonly content: string
  readonly async_tool_launch?: AsyncToolLaunch
  readonly model_content?: ReadonlyArray<ContentBlock>
}

export type ChatMessage =
  | SystemMessage
  | DeveloperMessage
  | UserMessage
  | InteractionMessage
  | AssistantMessage
  | ToolResultMessage
export type ModelMessage = ChatMessage

export type Role = ChatMessage["role"]

export interface ProviderToolCall {
  readonly id: string
  readonly name: string
  readonly arguments?: Readonly<Record<string, JsonValue>>
  readonly result?: string
  readonly done?: boolean
  readonly loaded_tool_names?: ReadonlyArray<string>
  /** Bounded provider evidence projected onto tool lifecycle events. */
  readonly source_refs?: ReadonlyArray<JsonObject>
}

/**
 * Who produced an assistant turn: `provider` names who served it (`"openai"`,
 * `"openrouter"`, `"llama.cpp"`), `api` the wire (`"openai-responses"`,
 * `"chat-completions"`), `model` the model that actually answered, as the
 * server reported it, and `requested_model` the model ID the request named.
 * Both are kept because they differ: a router answers `openrouter/auto` with
 * a model of its choice, and OpenRouter names `anthropic/claude-haiku-5.5`
 * in every chunk of an answer to `anthropic/claude-haiku-5.5:nitro` (live,
 * 2026-11-16). `model` is what wrote the turn; `requested_model` is the route
 * a later request must name to reach the same writer, which is what replay
 * rules compare (`sameRoute`). The loop persists it untouched beside
 * `provider_state`.
 */
export interface MessageOrigin {
  readonly provider: string
  readonly api: string
  readonly model: string
  readonly requested_model: string
}

/**
 * Provider-owned replay state, keyed by provider id. The loop persists it on
 * the assistant message untouched; only the provider that wrote an entry
 * reads it back.
 */
export type ProviderState = Readonly<Record<string, JsonValue>>

/** Allocate opaque message identities with the platform Web Crypto API. */
export const messageId = (
  kind: "text" | "reasoning" | "tool" | "tool-load" | "tool-change"
): string => `${kind}-${globalThis.crypto.randomUUID()}`

/**
 * Host-supplied identity scheme for streamed text and reasoning messages,
 * applied at emission: the first event carrying a message already uses its
 * durable id, so deltas, terminal events, and persisted history agree by
 * construction. Minting is positional — `turn` is the model-call ordinal
 * within the run, `fragment` the ordinal of the output fragment the message
 * belongs to (always 0 for a provider that does not emit `OutputItemReady`),
 * and `index` the per-kind ordinal within that fragment. The fragment is
 * persisted as its own history record under `("text", { turn, fragment,
 * index: 0 })`, so a scheme that derives a record's part ids from its record
 * id names each streamed part the way history will. A provider retry
 * discards the attempt and re-requests the same coordinates, so a pure
 * scheme re-mints exactly the retracted ids.
 */
export type MessageIdMinter = (
  kind: "text" | "reasoning",
  position: { readonly turn: number; readonly fragment: number; readonly index: number }
) => string
