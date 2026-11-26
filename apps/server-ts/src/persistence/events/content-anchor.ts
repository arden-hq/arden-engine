import { SERVER_EVENT_TYPE, type ChatProjectionEvent } from "@arden-hq/protocol"
import { CONTENT_START } from "@arden-hq/protocol/chat"
import type { SessionEventRecord } from "./model.js"

export function withContentAnchor(
  event: ChatProjectionEvent,
  retained: ReadonlyArray<{ readonly fromSequence: number; readonly record: SessionEventRecord }>
): ChatProjectionEvent {
  if (
    event.type !== SERVER_EVENT_TYPE.textMessageEnd &&
    event.type !== SERVER_EVENT_TYPE.reasoningMessageEnd
  )
    return event
  const deltaType =
    event.type === SERVER_EVENT_TYPE.textMessageEnd
      ? SERVER_EVENT_TYPE.textMessageContent
      : SERVER_EVENT_TYPE.reasoningMessageContent
  const first = retained.find(
    ({ record }) =>
      record.event.type === deltaType &&
      record.event.message_id === event.message_id &&
      record.event.delta.trim().length > 0
  )
  return first === undefined
    ? event
    : { ...event, content_start: { kind: CONTENT_START.anchored, seq: first.fromSequence } }
}
