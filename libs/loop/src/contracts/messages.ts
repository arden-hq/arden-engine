import type { ToolExecution } from "@arden-hq/std/message-vocabulary"
import { INTERACTION_KIND, INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
export type JsonPrimitive = string | number | boolean | null
export {
  INTERACTION_KINDS,
  INTERACTION_OUTCOMES,
  INTERACTION_SOURCES,
  type InteractionKind,
  type InteractionOutcome,
  type InteractionSource
} from "@arden-hq/std/message-vocabulary"
import type {
  InteractionKind,
  InteractionOutcome,
  InteractionSource
} from "@arden-hq/std/message-vocabulary"
export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }
export type JsonObject = Readonly<Record<string, JsonValue>>
export type Metadata = Readonly<Record<string, unknown>>

export type MaybePromise<A> = A | PromiseLike<A>

// Standard Schema v1 — vendored type-only interface (https://standardschema.dev).

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

export const CONTENT_BLOCK_TYPE = {
  text: "text",
  image: "image",
  audio: "audio",
  context: "context"
} as const
export type ContentBlockType = (typeof CONTENT_BLOCK_TYPE)[keyof typeof CONTENT_BLOCK_TYPE]

export interface TextContent {
  readonly type: typeof CONTENT_BLOCK_TYPE.text
  readonly text: string
}

export interface ImageContent {
  readonly type: typeof CONTENT_BLOCK_TYPE.image
  readonly media_type: string
  readonly data: string
}

export interface AudioContent {
  readonly type: typeof CONTENT_BLOCK_TYPE.audio
  readonly media_type: string
  readonly data: string
}

export interface ContextContent {
  readonly type: typeof CONTENT_BLOCK_TYPE.context
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

export const TOOL_CALL_TYPE = { function: "function" } as const
export type ToolCallType = (typeof TOOL_CALL_TYPE)[keyof typeof TOOL_CALL_TYPE]

export interface ToolCall {
  readonly async?: boolean
  readonly id: string
  readonly type: ToolCallType
  readonly function: FunctionCall
  readonly started_at?: number
  readonly parent_id?: string | null
  readonly display_title?: string
}

export const ASSISTANT_TEXT_PHASE = {
  commentary: "commentary",
  finalAnswer: "final_answer"
} as const
export type AssistantTextPhase = (typeof ASSISTANT_TEXT_PHASE)[keyof typeof ASSISTANT_TEXT_PHASE]
export const isAssistantTextPhase = (value: unknown): value is AssistantTextPhase =>
  value === ASSISTANT_TEXT_PHASE.commentary || value === ASSISTANT_TEXT_PHASE.finalAnswer

export interface InteractionActor extends JsonObject {
  readonly source: InteractionSource
  readonly id: string
  readonly name?: string
}

export interface InteractionRecipient extends JsonObject {
  readonly source: typeof INTERACTION_SOURCE.agent
  readonly id: string
}

export interface InteractionReference extends JsonObject {
  readonly type: "message" | "run" | "tool_call" | "workflow"
  readonly id: string
}

export interface ReplyContext extends JsonObject {
  readonly messageId: string
  readonly role: typeof ROLE.user | typeof ROLE.assistant
  readonly content: string
}

export const ASSISTANT_OUTPUT_PART_TYPE = {
  reasoning: "reasoning",
  text: "text",
  toolCall: "tool_call"
} as const
export type AssistantOutputPartType =
  (typeof ASSISTANT_OUTPUT_PART_TYPE)[keyof typeof ASSISTANT_OUTPUT_PART_TYPE]
export type ReadablePartType = Exclude<
  AssistantOutputPartType,
  typeof ASSISTANT_OUTPUT_PART_TYPE.toolCall
>

export {
  TOOL_EXECUTION,
  isToolExecution,
  type ToolExecution
} from "@arden-hq/std/message-vocabulary"

export interface ReasoningOutputPart {
  readonly type: typeof ASSISTANT_OUTPUT_PART_TYPE.reasoning
  readonly text: string
}

export interface TextOutputPart {
  readonly type: typeof ASSISTANT_OUTPUT_PART_TYPE.text
  readonly text: string
  readonly phase?: AssistantTextPhase
}

export interface ToolCallOutputPart {
  readonly type: typeof ASSISTANT_OUTPUT_PART_TYPE.toolCall
  readonly tool_call_id: string
  readonly execution: ToolExecution
}

export type ReadableOutputPart = ReasoningOutputPart | TextOutputPart
export type AssistantOutputPart = ReadableOutputPart | ToolCallOutputPart

export const toolCallPart = (toolCallId: string, execution: ToolExecution): ToolCallOutputPart => ({
  type: ASSISTANT_OUTPUT_PART_TYPE.toolCall,
  tool_call_id: toolCallId,
  execution
})

export const isTextPart = (part: AssistantOutputPart | undefined): part is TextOutputPart =>
  part?.type === ASSISTANT_OUTPUT_PART_TYPE.text
export const isReasoningPart = (
  part: AssistantOutputPart | undefined
): part is ReasoningOutputPart => part?.type === ASSISTANT_OUTPUT_PART_TYPE.reasoning
export const isToolCallPart = (part: AssistantOutputPart | undefined): part is ToolCallOutputPart =>
  part?.type === ASSISTANT_OUTPUT_PART_TYPE.toolCall

interface MessageFields extends Metadata {
  readonly message_id?: string
  readonly client_id?: string
}

export interface AsyncToolLaunch {
  readonly call_id: string
}

export interface SystemMessage extends MessageFields {
  readonly role: typeof ROLE.system
  readonly content: string | ReadonlyArray<Metadata>
}

interface DeveloperMessage extends MessageFields {
  readonly role: typeof ROLE.developer
  readonly content: string | ReadonlyArray<Metadata>
  readonly loaded_tools?: ReadonlyArray<string>
  readonly removed_tools?: ReadonlyArray<string>
}

export interface UserMessage extends MessageFields {
  readonly role: typeof ROLE.user
  readonly content?: string | null | ReadonlyArray<Metadata>
  readonly replyTo?: ReplyContext | ReadonlyArray<ReplyContext>
}

export type InteractionMessage = MessageFields & {
  readonly role: typeof ROLE.interaction
  readonly from: InteractionActor
  readonly to?: InteractionRecipient
  readonly content: string | ReadonlyArray<Metadata>
  readonly preview?: string
  readonly caused_by?: InteractionReference
  readonly rejected_message_ids?: ReadonlyArray<string>
} & (
    | { readonly kind: Exclude<InteractionKind, "completion"> }
    | { readonly kind: typeof INTERACTION_KIND.completion; readonly outcome: InteractionOutcome }
  )

export interface AssistantMessage extends MessageFields {
  readonly role: typeof ROLE.assistant
  readonly content?: string | null | ReadonlyArray<Metadata>
  readonly tool_calls?: ReadonlyArray<ToolCall>
  readonly provider_tool_calls?: ReadonlyArray<ProviderToolCall> | null
  readonly reasoning_content?: string | null
  readonly output_parts?: ReadonlyArray<AssistantOutputPart>
  readonly provider_state?: ProviderState
  readonly origin?: MessageOrigin
}

export interface ToolResultMessage extends MessageFields {
  readonly role: typeof ROLE.tool
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
  readonly source_refs?: ReadonlyArray<JsonObject>
}

export interface MessageOrigin {
  readonly provider: string
  readonly api: string
  readonly model: string
  readonly requested_model: string
}

export type ProviderState = Readonly<Record<string, JsonValue>>

export const messageId = (
  kind: "text" | "reasoning" | "tool" | "tool-load" | "tool-change"
): string => `${kind}-${globalThis.crypto.randomUUID()}`

export type MessageIdMinter = (
  kind: ReadablePartType,
  position: { readonly turn: number; readonly fragment: number; readonly index: number }
) => string
