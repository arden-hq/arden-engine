import { SERVER_EVENT_TYPE } from "../../common/event-types.js"
import { Schema } from "effect"
import { event } from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { JsonRecord } from "../../common/json.js"
import {
  ContentStartSchema,
  MessageClosureSchema,
  StreamRecordSchema,
  type ContentStart,
  type MessageClosure,
  type StreamRecord
} from "./text.js"

export interface ReasoningMessageStartEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.reasoningMessageStart
  readonly message_id: string
  readonly record: StreamRecord
}

export interface ReasoningMessageContentEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.reasoningMessageContent
  readonly message_id: string
  readonly delta: string
}

export interface ReasoningMessageEndEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.reasoningMessageEnd
  readonly message_id: string
  readonly closure: MessageClosure
  readonly content_start: ContentStart
}

export type ReasoningStreamEvent =
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent

export const ReasoningMessageStartEventSchema = event(SERVER_EVENT_TYPE.reasoningMessageStart, {
  message_id: Schema.String,
  record: StreamRecordSchema
})

export const ReasoningMessageContentEventSchema = event(SERVER_EVENT_TYPE.reasoningMessageContent, {
  message_id: Schema.String,
  delta: Schema.String
})

export const ReasoningMessageEndEventSchema = event(SERVER_EVENT_TYPE.reasoningMessageEnd, {
  message_id: Schema.String,
  closure: MessageClosureSchema,
  content_start: ContentStartSchema
})

export const reasoningStreamEventSchemas = [
  ReasoningMessageStartEventSchema,
  ReasoningMessageContentEventSchema,
  ReasoningMessageEndEventSchema
] as const

export type ReasoningStreamEventAgrees = Assert<
  Agrees<(typeof reasoningStreamEventSchemas)[number]["Type"], ReasoningStreamEvent>
>
