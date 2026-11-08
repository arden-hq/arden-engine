import { Schema } from "effect"
import { event, optionalString } from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { AssistantTextPhase } from "../history.js"
import type { CommonServerEventFields } from "../../common/event-fields.js"

export interface TextMessageStartEvent extends CommonServerEventFields {
  readonly type: "TEXT_MESSAGE_START"
  readonly message_id: string
  readonly role?: string
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
  /**
   * The authoritative full text: clients replace accumulated deltas with it.
   * Absent only on abnormal closure (failure/cancel/recovery), where the
   * accumulated stream stands.
   */
  readonly content?: string
  /** Sequence where visible content began, retained when deltas are pruned. */
  readonly content_start_seq?: number
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

export const TextMessageStartEventSchema = event("TEXT_MESSAGE_START", {
  message_id: Schema.String,
  role: optionalString
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
  // Present on every normal completion; absent only on abnormal closure
  // (failure/cancel/recovery), where the accumulated stream stands.
  content: optionalString,
  content_start_seq: Schema.optionalKey(Schema.Int)
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
