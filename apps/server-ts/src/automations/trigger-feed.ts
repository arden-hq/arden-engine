import {
  feedsActivityTriggers,
  type TriggerFeedRecord
} from "../persistence/automations/triggers.js"
import type { SessionLifecycleDelivery } from "../persistence/sessions/events.js"

export const triggerFeedRecord = (
  delivery: Extract<SessionLifecycleDelivery, { kind: "record" }>
): TriggerFeedRecord => {
  const event = delivery.event
  const base = {
    sequence: delivery.sequence,
    atMs: delivery.createdAtMs,
    journal: { atMs: delivery.createdAtMs, event }
  }
  if (event.type === "chat_input_committed") {
    return { ...base, kind: "input_committed", sessionId: event.chat_session_id }
  }
  if (event.type === "run_settled" && event.personal && event.status === "completed") {
    return { ...base, kind: "run_completed", sessionId: event.session_id }
  }
  if (
    event.type === "session_activity" &&
    feedsActivityTriggers({
      sessionType: event.session.session_type ?? "chat",
      originAutomationId: event.session.origin_automation_id ?? null
    })
  ) {
    return { ...base, kind: "activity", sessionId: event.session.session_id }
  }
  return { ...base, kind: "other", sessionId: null }
}
