import { SERVER_EVENT_TYPE } from "../../common/event-types.js"
import type { ApprovalEvent } from "./approval.js"
import type { ChatEventFrame, Framed } from "../../common/event-fields.js"
import type { JsonRecord } from "../../common/json.js"
import type { HistoryResponse } from "../history.js"
import type { ReasoningStreamEvent } from "./reasoning.js"
import type { RunLifecycleEvent } from "./run.js"
import type { SessionStateEvent } from "./session.js"
import type { TextStreamEvent } from "./text.js"
import type { ToolCallEvent } from "./tool.js"

export interface StreamKeepaliveEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.streamKeepalive
  readonly session_id: string
  readonly seq: number
  readonly latest_seq: number
}

export interface SessionResumeSnapshot extends JsonRecord {
  readonly version: 1
  readonly applied_seq: number
  readonly history: HistoryResponse
  readonly active_events: ReadonlyArray<SnapshotProjectionEvent>
}

export type SnapshotProjectionEvent = Framed<
  ChatProjectionEvent,
  ChatEventFrame & { readonly replay: true }
>

export interface StreamSnapshotEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.streamSnapshot
  readonly session_id: string
  readonly seq: number
  readonly snapshot: SessionResumeSnapshot
}

export interface StreamLiveEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.streamLive
  readonly session_id: string
  readonly seq: number
  readonly caught_up_through: number
}

export interface StreamOverflowEvent extends JsonRecord {
  readonly type: typeof SERVER_EVENT_TYPE.streamOverflow
  readonly session_id: string
  readonly seq: number
  readonly cursor: number
  readonly reason: "follower_buffer" | "active_projection"
}

export type ChatProjectionEvent =
  | RunLifecycleEvent
  | TextStreamEvent
  | ReasoningStreamEvent
  | ToolCallEvent
  | ApprovalEvent
  | SessionStateEvent

export type FramedChatProjectionEvent = Framed<ChatProjectionEvent, ChatEventFrame>

export type ChatServerEvent =
  | FramedChatProjectionEvent
  | StreamKeepaliveEvent
  | StreamSnapshotEvent
  | StreamLiveEvent
  | StreamOverflowEvent
