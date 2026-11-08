import type { ChatProjectionEvent } from "@arden-hq/protocol"
import type { SessionEventRecord } from "./model.js"

export function withContentAnchor(
  event: ChatProjectionEvent,
  retained: ReadonlyArray<{ readonly fromSequence: number; readonly record: SessionEventRecord }>
): ChatProjectionEvent {
  if (event.type !== "TEXT_MESSAGE_END" && event.type !== "REASONING_MESSAGE_END") return event
  const deltaType =
    event.type === "TEXT_MESSAGE_END" ? "TEXT_MESSAGE_CONTENT" : "REASONING_MESSAGE_CONTENT"
  const first = retained.find(
    ({ record }) =>
      record.event.type === deltaType &&
      record.event.message_id === event.message_id &&
      record.event.delta.trim().length > 0
  )
  return first === undefined ? event : { ...event, content_start_seq: first.fromSequence }
}
