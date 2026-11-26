import { SERVER_EVENT_TYPE } from "../../common/event-types.js"
import { Schema } from "effect"
import {
  SessionFocusSchema,
  TodoListItemSchema,
  event,
  sessionEvent,
  NonNegativeIntSchema
} from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { JsonRecord } from "../../common/json.js"
import type { SessionFocus } from "../../sessions/focus/contracts.js"
import type { TodoListItem } from "../../sessions/todos/contracts.js"

export interface MessageIngestedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.messageIngested
  readonly client_id: string
  readonly run_id: string
}

export interface TranscriptChangedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.transcriptChanged
}

export interface CompactionStartedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.compactionStarted
  readonly run_id: string
  readonly compaction_id: string
  readonly messages_before: number
}

export const COMPACTION_OUTCOME = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled"
} as const

export type CompactionOutcome = (typeof COMPACTION_OUTCOME)[keyof typeof COMPACTION_OUTCOME]

export interface CompactionFinishedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.compactionFinished
  readonly run_id: string
  readonly compaction_id: string
  readonly outcome: CompactionOutcome
  readonly messages_before: number
  readonly messages_after: number
}

export interface FocusUpdatedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.focusUpdated
  readonly session_id: string
  readonly focus: SessionFocus
}

export interface FocusClearedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.focusCleared
  readonly session_id: string
}

export interface TodoUpdatedEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.todoUpdated
  readonly run_id: string
  readonly tool_call_id: string
  readonly explanation: TodoExplanation
  readonly items: ReadonlyArray<TodoListItem>
}

export const TODO_EXPLANATION = { none: "none", given: "given" } as const

export type TodoExplanation =
  | { readonly kind: typeof TODO_EXPLANATION.none }
  | { readonly kind: typeof TODO_EXPLANATION.given; readonly text: string }

export type SessionStateEvent =
  | MessageIngestedEvent
  | TranscriptChangedEvent
  | CompactionStartedEvent
  | CompactionFinishedEvent
  | FocusUpdatedEvent
  | FocusClearedEvent
  | TodoUpdatedEvent

export const MessageIngestedEventSchema = event(SERVER_EVENT_TYPE.messageIngested, {
  client_id: Schema.String,
  run_id: Schema.String
})

export const TranscriptChangedEventSchema = event(SERVER_EVENT_TYPE.transcriptChanged, {})

export const CompactionStartedEventSchema = event(SERVER_EVENT_TYPE.compactionStarted, {
  run_id: Schema.String,
  compaction_id: Schema.String,
  messages_before: NonNegativeIntSchema
})

export const CompactionFinishedEventSchema = event(SERVER_EVENT_TYPE.compactionFinished, {
  run_id: Schema.String,
  compaction_id: Schema.String,
  outcome: Schema.Literals(Object.values(COMPACTION_OUTCOME)),
  messages_before: NonNegativeIntSchema,
  messages_after: NonNegativeIntSchema
}).check(
  Schema.makeFilter((event) => {
    if (
      event.outcome === COMPACTION_OUTCOME.succeeded &&
      event.messages_after < event.messages_before
    ) {
      return undefined
    }
    if (
      event.outcome !== COMPACTION_OUTCOME.succeeded &&
      event.messages_after === event.messages_before
    ) {
      return undefined
    }
    return {
      path: ["messages_after"],
      issue:
        event.outcome === COMPACTION_OUTCOME.succeeded
          ? "must be less than messages_before after successful compaction"
          : "must equal messages_before when compaction does not succeed"
    }
  })
)

export const FocusUpdatedEventSchema = sessionEvent(SERVER_EVENT_TYPE.focusUpdated, Schema.String, {
  focus: SessionFocusSchema
})

export const FocusClearedEventSchema = sessionEvent(
  SERVER_EVENT_TYPE.focusCleared,
  Schema.String,
  {}
)

export const TodoUpdatedEventSchema = event(SERVER_EVENT_TYPE.todoUpdated, {
  run_id: Schema.String,
  tool_call_id: Schema.String,
  explanation: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(TODO_EXPLANATION.none) }),
    Schema.Struct({ kind: Schema.Literal(TODO_EXPLANATION.given), text: Schema.String })
  ]),
  items: Schema.Array(TodoListItemSchema)
})

export const sessionStateEventSchemas = [
  MessageIngestedEventSchema,
  TranscriptChangedEventSchema,
  CompactionStartedEventSchema,
  CompactionFinishedEventSchema,
  FocusUpdatedEventSchema,
  FocusClearedEventSchema,
  TodoUpdatedEventSchema
] as const

export type SessionStateEventAgrees = Assert<
  Agrees<(typeof sessionStateEventSchemas)[number]["Type"], SessionStateEvent>
>
