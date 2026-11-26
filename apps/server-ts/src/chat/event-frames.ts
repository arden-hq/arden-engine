import type {
  FramedChatProjectionEvent,
  SnapshotProjectionEvent,
  StreamLiveEvent,
  StreamOverflowEvent,
  StreamSnapshotEvent
} from "@arden-hq/protocol"
import { type HistoryResponse } from "@arden-hq/protocol/chat"
import { DateTime } from "effect"
import { Event as SseEvent } from "effect/unstable/encoding/Sse"
import type { SessionEventRecord } from "../persistence/events/model.js"

export interface ChatEventFrame {
  readonly session_id: string
  readonly seq: number
  readonly timestamp: number
}

export const chatEventFrame = (record: SessionEventRecord): ChatEventFrame => ({
  session_id: record.sessionId,
  seq: record.sequence,
  timestamp: DateTime.toEpochMillis(record.createdAt)
})
export const eventRecordToSse = (record: SessionEventRecord, replay = false): SseEvent => {
  const payload: FramedChatProjectionEvent = { ...record.event, ...chatEventFrame(record), replay }
  return {
    _tag: "Event",
    id: String(record.sequence),
    event: record.event.type,
    data: JSON.stringify(payload)
  }
}

export const snapshotEvent = (appliedSequence: number, data: string): SseEvent => ({
  _tag: "Event",
  id: String(appliedSequence),
  event: "stream_snapshot",
  data
})

export const snapshotProtocolEvent = (
  sessionId: string,
  appliedSequence: number,
  history: HistoryResponse,
  activeEvents: ReadonlyArray<SnapshotProjectionEvent>
): StreamSnapshotEvent => ({
  type: "stream_snapshot",
  session_id: sessionId,
  seq: appliedSequence,
  snapshot: {
    version: 1,
    applied_seq: appliedSequence,
    history,
    active_events: activeEvents
  }
})

export const liveEvent = (sessionId: string, caughtUpThrough: number): SseEvent =>
  protocolEventToSse({
    type: "stream_live",
    session_id: sessionId,
    seq: caughtUpThrough,
    caught_up_through: caughtUpThrough
  })

export const overflowEvent = (
  sessionId: string,
  cursor: number,
  reason: StreamOverflowEvent["reason"]
): SseEvent =>
  protocolEventToSse({
    type: "stream_overflow",
    session_id: sessionId,
    seq: cursor,
    cursor,
    reason
  })

const protocolEventToSse = (
  event: StreamSnapshotEvent | StreamLiveEvent | StreamOverflowEvent
): SseEvent => ({
  _tag: "Event",
  id: String(event.seq),
  event: event.type,
  data: JSON.stringify(event)
})

export const keepaliveEvent = (sessionId: string, sequence: number): SseEvent => ({
  _tag: "Event",
  id: String(sequence),
  event: "stream_keepalive",
  data: JSON.stringify({
    type: "stream_keepalive",
    session_id: sessionId,
    seq: sequence,
    latest_seq: sequence
  })
})
