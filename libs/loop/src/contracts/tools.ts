import { ROLE } from "@arden-hq/std/message-vocabulary"
import type {
  ChatMessage,
  ContentBlock,
  JsonObject,
  MaybePromise,
  Metadata,
  ToolCall
} from "./messages.js"

export interface ToolMeta {
  readonly background?: boolean
  readonly detached?: boolean
  readonly name: string
  readonly hosted?: boolean
  readonly changes_state?: boolean
  readonly concurrency_group?: string | null
  readonly ends_turn?: EndsTurn
  readonly deferred?: boolean
  readonly group?: string
  readonly input_sources?: ReadonlyArray<ToolInputSource>
  readonly host?: Metadata
}

export type EndsTurn = boolean | { readonly argument: string; readonly equals: string }

export const callEndsTurn = (
  meta: { readonly ends_turn?: EndsTurn } | undefined,
  args: Readonly<Record<string, unknown>>
): boolean => {
  const rule = meta?.ends_turn
  if (rule === undefined || typeof rule === "boolean") return rule === true
  return args[rule.argument] === rule.equals
}

export const mayEndTurn = (meta: { readonly ends_turn?: EndsTurn } | undefined): boolean =>
  meta?.ends_turn !== undefined && meta.ends_turn !== false

export const canRunInBackground = (
  meta: Pick<ToolMeta, "hosted" | "detached" | "ends_turn"> | undefined
): boolean => meta?.hosted !== true && meta?.detached !== true && !mayEndTurn(meta)

export interface ToolInputSource {
  readonly input: string
  readonly tools: ReadonlyArray<string>
}

export interface ToolEntry {
  readonly description: string
  readonly parameters: JsonSchema
  readonly meta: ToolMeta
}

export type JsonSchema = Readonly<Record<string, unknown>>

export const JSON_SCHEMA_KEYWORD = {
  description: "description",
  properties: "properties",
  items: "items",
  oneOf: "oneOf",
  anyOf: "anyOf"
} as const
export type JsonSchemaKeyword = (typeof JSON_SCHEMA_KEYWORD)[keyof typeof JSON_SCHEMA_KEYWORD]
export const isSchemaKeyword = (key: string, keyword: JsonSchemaKeyword): boolean => key === keyword

export interface ToolDeclaration {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly hosted?: boolean
  readonly async?: boolean
  readonly group?: string
}

export interface ToolSearch {
  readonly description: string
  readonly parameters: JsonSchema
  readonly search: (input: { readonly query: string; readonly limit?: number }) => ToolSearchResult
  readonly lookup: (names: ReadonlyArray<string>) => ReadonlyArray<ToolDeclaration>
}

export interface ToolSearchResult {
  readonly tools: ReadonlyArray<ToolDeclaration>
  readonly matched: ReadonlyArray<string>
}

export const loadedToolNames = (messages: ReadonlyArray<ChatMessage>): Set<string> => {
  const loaded = new Set<string>()
  for (const message of messages) {
    if (message.role === ROLE.developer) {
      for (const name of message.loaded_tools ?? []) loaded.add(name)
      for (const name of message.removed_tools ?? []) loaded.delete(name)
    }
    if (message.role === ROLE.assistant) {
      for (const call of message.provider_tool_calls ?? []) {
        for (const name of call.loaded_tool_names ?? []) loaded.add(name)
      }
    }
  }
  return loaded
}

export interface ToolResult {
  readonly content: string
  readonly preview: string
  readonly is_error?: boolean
  readonly retryable?: boolean | null
  readonly data?: JsonObject | null
  readonly message_extras?: Metadata
  readonly host?: Metadata
  readonly model_content?: ReadonlyArray<ContentBlock>
}

export type ToolArgumentErrorCode = "invalid_tool_arguments" | "unavailable_tool"

export interface ToolArgumentError {
  readonly code: ToolArgumentErrorCode
  readonly message: string
}

export interface PendingToolCall {
  readonly toolCall: ToolCall
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly displayTitle?: string
  readonly argumentError?: ToolArgumentError
}

export interface ToolApprovalContext {
  readonly approved: true
  readonly reviewer?: true
  readonly feedback: string | null
  readonly grantStanding?: boolean
  readonly data?: JsonObject
  readonly edited?: ToolApprovalEdits
  readonly alternative?: "draft"
}

export interface ToolApprovalEdits {
  readonly requested: JsonObject
  readonly arguments: JsonObject
}

export interface ToolProgressUpdate {
  readonly message: string
  readonly data?: Readonly<Record<string, unknown>>
}

export interface ToolCallRequest {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly toolCallId: string
  readonly approval?: ToolApprovalContext
  readonly signal?: AbortSignal
  readonly messages?: ReadonlyArray<ChatMessage>
  readonly emit?: (update: ToolProgressUpdate) => void
  readonly beforeExecute?: () => Promise<ToolResult | undefined>
  readonly phase?: (phase: ToolPhase) => void
  readonly backgrounded?: Promise<void>
}

export const TOOL_PHASE = { waiting: "waiting", executing: "executing" } as const
export type ToolPhase = (typeof TOOL_PHASE)[keyof typeof TOOL_PHASE]

export interface HeldToolCall {
  readonly toolCallId: string
  readonly result: Promise<ToolResult | undefined>
  readonly stop: () => void
}

export interface ToolDisplayTitle {
  readonly argument: string
  readonly maxLength: number
}

export interface Toolset {
  readonly displayTitle?: ToolDisplayTitle
  readonly entries: () => MaybePromise<ReadonlyArray<ToolEntry>>
  readonly metadata?: (name: string) => MaybePromise<ToolMeta | undefined>
  readonly loadedNames: () => MaybePromise<ReadonlySet<string>>
  readonly load: (names: ReadonlySet<string>) => MaybePromise<void>
  readonly seedLoadedNames?: (names: ReadonlySet<string>) => MaybePromise<void>
  readonly execute: (request: ToolCallRequest) => MaybePromise<ToolResult>
  readonly settleRefusal?: (
    request: ToolCallRequest,
    result: ToolResult
  ) => MaybePromise<ToolResult>
  readonly decorateResult?: (request: ToolCallRequest, result: ToolResult) => ToolResult
}

export type ToolCallNext = (request: ToolCallRequest) => MaybePromise<ToolResult>
export type ToolCallMiddleware = (
  request: ToolCallRequest,
  next: ToolCallNext
) => MaybePromise<ToolResult>
