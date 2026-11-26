import {
  INTERACTION_KIND,
  INTERACTION_SOURCE,
  type ImageMediaType
} from "@arden-hq/std/message-vocabulary"
import type { JsonRecord } from "../common/json.js"
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
import type { SessionRuntimeSnapshot } from "./runtime.js"
export type { HistoryToolCall } from "./history-tool-call.js"
import type { HistoryMessage, TEXT_PHASE } from "./history-message.js"
export type * from "./history-message.js"

export { IMAGE_MEDIA_TYPE, type ImageMediaType } from "@arden-hq/std/message-vocabulary"

export const CHAT_SENT_FROM = {
  visualization: "visualization",
  answer: "answer",
  cli: "cli"
} as const

export type ChatSentFrom = (typeof CHAT_SENT_FROM)[keyof typeof CHAT_SENT_FROM]

export const CONNECTION_ARRIVAL = { connected: "connected", declined: "declined" } as const

export type ConnectionArrivalOutcome = (typeof CONNECTION_ARRIVAL)[keyof typeof CONNECTION_ARRIVAL]

export interface ConnectionArrival {
  readonly tool_call_id: string
  readonly server: string
  readonly outcome: ConnectionArrivalOutcome
  readonly offered_at: string
  readonly at: string
}

export interface HistoryImage extends JsonRecord {
  readonly type: "image"
  readonly media_type: ImageMediaType
  readonly data: string
}

export const ACTOR_NAME = { unnamed: "unnamed", named: "named" } as const

export type ActorName =
  | { readonly kind: typeof ACTOR_NAME.unnamed }
  | { readonly kind: typeof ACTOR_NAME.named; readonly text: string }

export interface InteractionActor extends JsonRecord {
  readonly source: InteractionSource
  readonly id: string
  readonly name: ActorName
}

export interface InteractionRecipient extends JsonRecord {
  readonly source: typeof INTERACTION_SOURCE.agent
  readonly id: string
}

export const INTERACTION_REFERENCE = {
  message: "message",
  run: "run",
  toolCall: "tool_call",
  workflow: "workflow"
} as const

export type InteractionReferenceType =
  (typeof INTERACTION_REFERENCE)[keyof typeof INTERACTION_REFERENCE]

export interface InteractionReference extends JsonRecord {
  readonly type: InteractionReferenceType
  readonly id: string
}

export const SENDER_ADDRESS = { unaddressed: "unaddressed", addressed: "addressed" } as const

export type SenderAddress =
  | { readonly kind: typeof SENDER_ADDRESS.unaddressed }
  | { readonly kind: typeof SENDER_ADDRESS.addressed; readonly recipient: InteractionRecipient }

export const INTERACTION_PREVIEW = { unpreviewed: "unpreviewed", previewed: "previewed" } as const

export type InteractionPreview =
  | { readonly kind: typeof INTERACTION_PREVIEW.unpreviewed }
  | { readonly kind: typeof INTERACTION_PREVIEW.previewed; readonly text: string }

export const SENDER_CAUSE = { untraced: "untraced", traced: "traced" } as const

export type SenderCause =
  | { readonly kind: typeof SENDER_CAUSE.untraced }
  | { readonly kind: typeof SENDER_CAUSE.traced; readonly reference: InteractionReference }

export type InteractionSender = {
  readonly from: InteractionActor
  readonly to: SenderAddress
  readonly preview: InteractionPreview
  readonly caused_by: SenderCause
} & (
  | { readonly kind: Exclude<InteractionKind, "completion"> }
  | { readonly kind: typeof INTERACTION_KIND.completion; readonly outcome: InteractionOutcome }
)

export type Interaction = InteractionSender & { readonly content: string }

export interface AgentResult extends JsonRecord {
  readonly session_id: string
  readonly name: string
  readonly content: string
  readonly preview: InteractionPreview
}

export interface GmailSendReceipt extends JsonRecord {
  readonly kind: "gmail_send_v1"
  readonly provider_message_id: string
  readonly provider_thread_id: string
  readonly recipient: string
  readonly confirmed_at: string
}

export interface TurnShell extends JsonRecord {
  readonly turn_id: string
  readonly message_start_seq: number
  readonly message_end_seq: number
  readonly started_at: string
  readonly ended_at: string
  readonly has_work: boolean
  readonly has_tool_work: boolean
  readonly tool_calls: ReadonlyArray<TurnToolCallCount>
  readonly ending: TurnEnding
}

export const TURN_ENDING = { ended: "ended", failed: "failed" } as const

export type TurnEnding =
  | { readonly kind: typeof TURN_ENDING.ended }
  | { readonly kind: typeof TURN_ENDING.failed; readonly code: string; readonly message: string }

export const TOOL_COUNT_NAME = { unnamed: "unnamed", named: "named" } as const

export type ToolCountName =
  | { readonly kind: typeof TOOL_COUNT_NAME.unnamed }
  | { readonly kind: typeof TOOL_COUNT_NAME.named; readonly text: string }

export interface TurnToolCallCount extends JsonRecord {
  readonly name: string
  readonly display_name: ToolCountName
  readonly count: number
  readonly rejected: number
  readonly seqs: ReadonlyArray<number>
}

export interface HistoryPage extends JsonRecord {
  readonly has_more_before: boolean
  readonly has_more_after: boolean
  readonly bounds: PageBounds
}

export const PAGE_BOUNDS = { empty: "empty", bounded: "bounded" } as const

export type PageBounds =
  | { readonly kind: typeof PAGE_BOUNDS.empty }
  | { readonly kind: typeof PAGE_BOUNDS.bounded; readonly before: string; readonly after: string }

export const pageBounds = (before: string | undefined, after: string | undefined): PageBounds =>
  before === undefined || after === undefined
    ? { kind: PAGE_BOUNDS.empty }
    : { kind: PAGE_BOUNDS.bounded, before, after }

export const ACTIVE_WORK = { idle: "idle", running: "running" } as const

export type ActiveWork =
  | { readonly kind: typeof ACTIVE_WORK.idle }
  | { readonly kind: typeof ACTIVE_WORK.running; readonly work: TurnWorkResponse }

export const CONTEXT_LIMIT = { unresolved: "unresolved", resolved: "resolved" } as const

export const CONTEXT_MODEL = { unselected: "unselected", selected: "selected" } as const

type ContextModel =
  | { readonly kind: typeof CONTEXT_MODEL.unselected }
  | { readonly kind: typeof CONTEXT_MODEL.selected; readonly model_id: string }

export type ContextBudgetSnapshot = {
  readonly input_tokens: number
  readonly message_count: number
} & (
  | { readonly kind: typeof CONTEXT_LIMIT.unresolved; readonly model: ContextModel }
  | {
      readonly kind: typeof CONTEXT_LIMIT.resolved
      readonly model: string
      readonly hard_limit: number
      readonly compaction_trigger: number
    }
)

export interface HistoryResponse extends JsonRecord {
  readonly messages: ReadonlyArray<HistoryMessage>
  readonly active_work_tail: ActiveWork
  readonly runtime: SessionRuntimeSnapshot
  readonly page: HistoryPage
  readonly context_budget: ContextBudgetSnapshot
  readonly turn_shells: ReadonlyArray<TurnShell>
}

export interface TurnWorkResponse extends JsonRecord {
  readonly turn_id: string
  readonly messages: ReadonlyArray<HistoryMessage>
  readonly page: HistoryPage
}

export interface TurnDetailsResponse extends JsonRecord {
  readonly turn_id: string
  readonly messages: ReadonlyArray<HistoryMessage>
  readonly complete: boolean
}

export type AssistantTextPhase = typeof TEXT_PHASE.commentary | typeof TEXT_PHASE.finalAnswer
