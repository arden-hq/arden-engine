import { Schema } from "effect"
import { event } from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { AssistantTextPhase } from "../history.js"
import type { CommonServerEventFields } from "../../common/event-fields.js"

export const STREAM_RECORD = { part: "part", unowned: "unowned" } as const

export type StreamRecord =
  | { readonly kind: typeof STREAM_RECORD.part; readonly record_id: string }
  | { readonly kind: typeof STREAM_RECORD.unowned }

export const MESSAGE_CLOSURE = { complete: "complete", abandoned: "abandoned" } as const

export type MessageClosure =
  | { readonly kind: typeof MESSAGE_CLOSURE.complete; readonly content: string }
  | { readonly kind: typeof MESSAGE_CLOSURE.abandoned }

export const CONTENT_START = { unanchored: "unanchored", anchored: "anchored" } as const

export type ContentStart =
  | { readonly kind: typeof CONTENT_START.unanchored }
  | { readonly kind: typeof CONTENT_START.anchored; readonly seq: number }

export const messageEnd = (
  content: string | undefined
): { readonly closure: MessageClosure; readonly content_start: ContentStart } => ({
  closure:
    content === undefined
      ? { kind: MESSAGE_CLOSURE.abandoned }
      : { kind: MESSAGE_CLOSURE.complete, content },
  content_start: { kind: CONTENT_START.unanchored }
})

export interface TextMessageStartEvent extends CommonServerEventFields {
  readonly type: "TEXT_MESSAGE_START"
  readonly message_id: string
  readonly record: StreamRecord
}

/** Lossy presentation delta. TEXT_MESSAGE_END restates the full text. */
export interface TextMessageContentEvent extends CommonServerEventFields {
  readonly type: "TEXT_MESSAGE_CONTENT"
  readonly message_id: string
  readonly delta: string
}

export interface TextMessageEndEvent extends CommonServerEventFields {
  readonly type: "TEXT_MESSAGE_END"
  readonly message_id: string
  readonly closure: MessageClosure
  readonly content_start: ContentStart
}

export interface TextMessagePhaseEvent extends CommonServerEventFields {
  readonly type: "TEXT_MESSAGE_PHASE"
  readonly message_id: string
  readonly phase: AssistantTextPhase
}

/** Assistant text: one message streamed as start, content deltas, end, and phase changes. */
export type TextStreamEvent =
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | TextMessagePhaseEvent

export const StreamRecordSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(STREAM_RECORD.part), record_id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal(STREAM_RECORD.unowned) })
])

export const MessageClosureSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(MESSAGE_CLOSURE.complete), content: Schema.String }),
  Schema.Struct({ kind: Schema.Literal(MESSAGE_CLOSURE.abandoned) })
])

export const ContentStartSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(CONTENT_START.unanchored) }),
  Schema.Struct({ kind: Schema.Literal(CONTENT_START.anchored), seq: Schema.Int })
])

export const TextMessageStartEventSchema = event("TEXT_MESSAGE_START", {
  message_id: Schema.String,
  record: StreamRecordSchema
})

// Delta contract: every delta variant below is lossy presentation. A delta is
// either restated by a terminal event carrying the authoritative whole
// (TEXT_MESSAGE_CONTENT -> TEXT_MESSAGE_END.content, REASONING_MESSAGE_CONTENT
// -> REASONING_MESSAGE_END.content, TOOL_CALL_OUTPUT_DELTA ->
// TOOL_CALL_RESULT.content), restated by the durable transcript
// (TOOL_CALL_ARGS), or fire-and-forget (TOOL_CALL_PROGRESS). Clients replace
// on terminals; they never trust accumulation to be complete. The
// persistence-side classification is
// `EPHEMERAL_CHAT_EVENT_TYPES`/`isEphemeralChatEvent` in contracts.ts: these
// types are sequenced and streamed but never durably journaled.
export const TextMessageContentEventSchema = event("TEXT_MESSAGE_CONTENT", {
  message_id: Schema.String,
  delta: Schema.String
})

export const TextMessageEndEventSchema = event("TEXT_MESSAGE_END", {
  message_id: Schema.String,
  closure: MessageClosureSchema,
  content_start: ContentStartSchema
})

export const TextMessagePhaseEventSchema = event("TEXT_MESSAGE_PHASE", {
  message_id: Schema.String,
  phase: Schema.Literals(["commentary", "final_answer"] as const)
})

export const textStreamEventSchemas = [
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessagePhaseEventSchema
] as const

/** @internal Compile-time check that the schema and the type agree. */
export type TextStreamEventAgrees = Assert<
  Agrees<(typeof textStreamEventSchemas)[number]["Type"], TextStreamEvent>
>
