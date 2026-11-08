import { Schema } from "effect"
import { event, optionalString } from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { CommonServerEventFields } from "../../common/event-fields.js"

export interface ReasoningMessageStartEvent extends CommonServerEventFields {
  readonly type: "REASONING_MESSAGE_START"
  readonly message_id: string
  readonly role?: string
}

/**
 * Lossy presentation delta restated by `REASONING_MESSAGE_END.content` on
 * normal completion; the durable transcript
 * (`HistoryMessage.reasoning_content`) is authoritative after the turn.
 */
export interface ReasoningMessageContentEvent extends CommonServerEventFields {
  readonly type: "REASONING_MESSAGE_CONTENT"
  readonly message_id: string
  readonly delta: string
}

export interface ReasoningMessageEndEvent extends CommonServerEventFields {
  readonly type: "REASONING_MESSAGE_END"
  readonly message_id: string
  /** Authoritative restatement of the accumulated reasoning deltas; absent on
   * abnormal closure and in journals older than this field. */
  readonly content?: string
  readonly content_start_seq?: number
}

/** Reasoning text: one reasoning message streamed as start, content deltas, end. */
export type ReasoningStreamEvent =
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent

export const ReasoningMessageStartEventSchema = event("REASONING_MESSAGE_START", {
  message_id: Schema.String,
  role: optionalString
})

export const ReasoningMessageContentEventSchema = event("REASONING_MESSAGE_CONTENT", {
  message_id: Schema.String,
  delta: Schema.String
})

export const ReasoningMessageEndEventSchema = event("REASONING_MESSAGE_END", {
  message_id: Schema.String,
  // Present on every normal completion so the reasoning deltas have a
  // restating terminal and can be pruned from live retention; absent on
  // abnormal closure and in journals older than this field, where the
  // accumulated stream stands.
  content: optionalString,
  content_start_seq: Schema.optionalKey(Schema.Int)
})

export const reasoningStreamEventSchemas = [
  ReasoningMessageStartEventSchema,
  ReasoningMessageContentEventSchema,
  ReasoningMessageEndEventSchema
] as const

/** @internal Compile-time check that the schema and the type agree. */
export type ReasoningStreamEventAgrees = Assert<
  Agrees<(typeof reasoningStreamEventSchemas)[number]["Type"], ReasoningStreamEvent>
>
