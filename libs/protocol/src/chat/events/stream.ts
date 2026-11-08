import type { ApprovalEvent } from "./approval.js"
import type { CommonServerEventFields } from "../../common/event-fields.js"
import type { HistoryResponse } from "../history.js"
import type { JsonRecord } from "../../common/json.js"
import type { ReasoningStreamEvent } from "./reasoning.js"
import type { RunLifecycleEvent } from "./run.js"
import type { SessionStateEvent } from "./session.js"
import type { TextStreamEvent } from "./text.js"
import type { ToolCallEvent } from "./tool.js"

export interface StreamKeepaliveEvent extends CommonServerEventFields {
  readonly type: "stream_keepalive"
  readonly latest_seq: number
}

export interface SessionResumeSnapshot extends JsonRecord {
  readonly version: 1
  readonly applied_seq: number
  readonly history: HistoryResponse
  /** Ordered semantic events not represented by the durable history checkpoint. */
  readonly active_events: ReadonlyArray<SnapshotProjectionEvent>
}

/** A replay-safe event included exactly once in a resume snapshot. */
export type SnapshotProjectionEvent = ChatProjectionEvent & {
  readonly session_id: string
  readonly seq: number
  readonly replay: true
}

export interface StreamSnapshotEvent extends CommonServerEventFields {
  readonly type: "stream_snapshot"
  readonly session_id: string
  readonly seq: number
  readonly snapshot: SessionResumeSnapshot
}

export interface StreamLiveEvent extends CommonServerEventFields {
  readonly type: "stream_live"
  readonly session_id: string
  readonly seq: number
  readonly caught_up_through: number
}

export interface StreamOverflowEvent extends CommonServerEventFields {
  readonly type: "stream_overflow"
  readonly session_id: string
  readonly seq: number
  readonly cursor: number
  readonly reason: "follower_buffer" | "active_projection"
}

/** Every event a chat session's projection stream can carry, by family. */
export type ChatProjectionEvent =
  | RunLifecycleEvent
  | TextStreamEvent
  | ReasoningStreamEvent
  | ToolCallEvent
  | ApprovalEvent
  | SessionStateEvent

export type ChatServerEvent =
  | ChatProjectionEvent
  | StreamKeepaliveEvent
  | StreamSnapshotEvent
  | StreamLiveEvent
  | StreamOverflowEvent
