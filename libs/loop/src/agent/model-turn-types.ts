import {
  type ChatMessage,
  type JsonObject,
  type Metadata,
  type ReadablePartType,
  type ToolCall
} from "../contracts/messages.js"
import type { ToolDisplayTitle, ToolMeta } from "../contracts/tools.js"
import {
  type CompletionResponse,
  type ModelProvider,
  type ModelProviderRequest
} from "../contracts/provider.js"
import type { AgentEvent } from "../contracts/events.js"

type AgentEventEmitter = (event: AgentEvent) => Promise<void>

export interface ModelTurnInput {
  readonly provider: ModelProvider
  readonly request: ModelProviderRequest
  readonly history: ChatMessage[]
  readonly metas: ReadonlyMap<string, ToolMeta>
  readonly emit: AgentEventEmitter
  readonly displayTitle?: ToolDisplayTitle
  readonly persistHost?: (host: Metadata) => JsonObject
  readonly mintMessageId?: (
    kind: ReadablePartType,
    position: { readonly fragment: number; readonly index: number }
  ) => string
  readonly onToolCallReady?: (call: ToolCall, checkpoint: () => Promise<void>) => Promise<void>
  readonly checkpoint?: () => Promise<void>
  readonly commitOutput?: (operation: () => Promise<void>) => Promise<void>
}

export interface ModelTurnOutput {
  readonly response: CompletionResponse
  readonly streamedToolInputIds: ReadonlySet<string>
  readonly lastTextId: string | null
}
