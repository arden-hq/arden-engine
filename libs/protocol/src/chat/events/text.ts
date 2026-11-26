import { SERVER_EVENT_TYPE } from "../../common/event-types.js"
import { Schema } from "effect"
import { event } from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { AssistantTextPhase } from "../history.js"
import { TEXT_PHASE } from "../history-message.js"
import type { JsonRecord } from "../../common/json.js"

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

export interface TextMessageStartEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.textMessageStart
  readonly message_id: string
  readonly record: StreamRecord
}

export interface TextMessageContentEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.textMessageContent
  readonly message_id: string
  readonly delta: string
}

export interface TextMessageEndEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.textMessageEnd
  readonly message_id: string
  readonly closure: MessageClosure
  readonly content_start: ContentStart
}

export interface TextMessagePhaseEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.textMessagePhase
  readonly message_id: string
  readonly phase: AssistantTextPhase
}

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

export const TextMessageStartEventSchema = event(SERVER_EVENT_TYPE.textMessageStart, {
  message_id: Schema.String,
  record: StreamRecordSchema
})

export const TextMessageContentEventSchema = event(SERVER_EVENT_TYPE.textMessageContent, {
  message_id: Schema.String,
  delta: Schema.String
})

export const TextMessageEndEventSchema = event(SERVER_EVENT_TYPE.textMessageEnd, {
  message_id: Schema.String,
  closure: MessageClosureSchema,
  content_start: ContentStartSchema
})

export const TextMessagePhaseEventSchema = event(SERVER_EVENT_TYPE.textMessagePhase, {
  message_id: Schema.String,
  phase: Schema.Literals([TEXT_PHASE.commentary, TEXT_PHASE.finalAnswer])
})

export const textStreamEventSchemas = [
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessagePhaseEventSchema
] as const

export type TextStreamEventAgrees = Assert<
  Agrees<(typeof textStreamEventSchemas)[number]["Type"], TextStreamEvent>
>
