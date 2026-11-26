import type { AutomationEvent } from "@arden-hq/protocol"
import type { Event as SseEvent } from "effect/unstable/encoding/Sse"
import {
  LIFECYCLE_DELIVERY,
  SESSION_LIFECYCLE_STREAM_ID,
  type SessionLifecycleDelivery
} from "../../persistence/sessions/events.js"
import { isInternalLifecycleEvent } from "../../persistence/sessions/internal-events.js"

type AppDelivery =
  | Extract<SessionLifecycleDelivery, { kind: "reset" }>
  | (Extract<SessionLifecycleDelivery, { kind: "record" }> & { readonly event: AutomationEvent })

export const forApp = (delivery: SessionLifecycleDelivery): delivery is AppDelivery =>
  delivery.kind === LIFECYCLE_DELIVERY.reset || !isInternalLifecycleEvent(delivery.event)

export const lifecycleSse = (delivery: AppDelivery): SseEvent => {
  if (delivery.kind === LIFECYCLE_DELIVERY.reset) {
    return {
      _tag: "Event",
      id: String(delivery.cursor),
      event: "stream_reset",
      data: JSON.stringify({
        type: "stream_reset",
        session_id: SESSION_LIFECYCLE_STREAM_ID,
        seq: delivery.cursor,
        reason: delivery.reason
      })
    }
  }
  return {
    _tag: "Event",
    id: String(delivery.sequence),
    event: delivery.event.type,
    data: JSON.stringify({
      session_id: SESSION_LIFECYCLE_STREAM_ID,
      ...delivery.event,
      seq: delivery.sequence,
      timestamp: delivery.event.timestamp ?? delivery.createdAtMs,
      ...(delivery.replayed ? { replay: true } : {})
    })
  }
}
