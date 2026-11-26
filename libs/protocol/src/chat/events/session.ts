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
  readonly type: "message_ingested"
  readonly client_id: string
  readonly run_id: string
}

export interface TranscriptChangedEvent extends JsonRecord {
  readonly type: "transcript_changed"
}

export interface CompactionStartedEvent extends JsonRecord {
  readonly type: "compaction_started"
  readonly run_id: string
  readonly compaction_id: string
  readonly messages_before: number
}

export interface CompactionFinishedEvent extends JsonRecord {
  readonly type: "compaction_finished"
  readonly run_id: string
  readonly compaction_id: string
  readonly outcome: "succeeded" | "failed" | "cancelled"
  readonly messages_before: number
  readonly messages_after: number
}

/** A Goal's change, as older journals carry it; nothing emits it now. */
export interface FocusUpdatedEvent extends JsonRecord {
  readonly type: "focus_updated"
  readonly session_id: string
  readonly focus: SessionFocus
}

/** A Goal cleared, as older journals carry it; nothing emits it now. */
export interface FocusClearedEvent extends JsonRecord {
  readonly type: "focus_cleared"
  readonly session_id: string
}

export interface TodoUpdatedEvent extends JsonRecord {
  readonly type: "todo_updated"
  readonly run_id: string
  readonly tool_call_id: string
  readonly explanation: TodoExplanation
  readonly items: ReadonlyArray<TodoListItem>
}

export const TODO_EXPLANATION = { none: "none", given: "given" } as const

export type TodoExplanation =
  | { readonly kind: typeof TODO_EXPLANATION.none }
  | { readonly kind: typeof TODO_EXPLANATION.given; readonly text: string }

/** Session state that changes under a run: ingested input, transcript, compaction, focus, todo. */
export type SessionStateEvent =
  | MessageIngestedEvent
  | TranscriptChangedEvent
  | CompactionStartedEvent
  | CompactionFinishedEvent
  | FocusUpdatedEvent
  | FocusClearedEvent
  | TodoUpdatedEvent

export const MessageIngestedEventSchema = event("message_ingested", {
  client_id: Schema.String,
  run_id: Schema.String
})

export const TranscriptChangedEventSchema = event("transcript_changed", {})

export const CompactionStartedEventSchema = event("compaction_started", {
  run_id: Schema.String,
  compaction_id: Schema.String,
  messages_before: NonNegativeIntSchema
})

export const CompactionFinishedEventSchema = event("compaction_finished", {
  run_id: Schema.String,
  compaction_id: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "cancelled"] as const),
  messages_before: NonNegativeIntSchema,
  messages_after: NonNegativeIntSchema
}).check(
  Schema.makeFilter((event) => {
    if (event.outcome === "succeeded" && event.messages_after < event.messages_before) {
      return undefined
    }
    if (event.outcome !== "succeeded" && event.messages_after === event.messages_before) {
      return undefined
    }
    return {
      path: ["messages_after"],
      issue:
        event.outcome === "succeeded"
          ? "must be less than messages_before after successful compaction"
          : "must equal messages_before when compaction does not succeed"
    }
  })
)

export const FocusUpdatedEventSchema = sessionEvent("focus_updated", Schema.String, {
  focus: SessionFocusSchema
})

export const FocusClearedEventSchema = sessionEvent("focus_cleared", Schema.String, {})

export const TodoUpdatedEventSchema = event("todo_updated", {
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

/** @internal Compile-time check that the schema and the type agree. */
export type SessionStateEventAgrees = Assert<
  Agrees<(typeof sessionStateEventSchemas)[number]["Type"], SessionStateEvent>
>
