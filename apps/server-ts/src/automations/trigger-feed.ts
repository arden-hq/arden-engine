import {
  feedsActivityTriggers,
  type TriggerFeedRecord
} from "../persistence/automations/triggers.js"
import { LINK, SERVER_EVENT_TYPE } from "@arden-hq/protocol"
import {
  INTERNAL_LIFECYCLE_EVENT,
  RUN_SETTLED_STATUS
} from "../persistence/sessions/internal-events.js"
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
  if (event.type === SERVER_EVENT_TYPE.chatInputCommitted) {
    return { ...base, kind: "input_committed", sessionId: event.chat_session_id }
  }
  if (
    event.type === INTERNAL_LIFECYCLE_EVENT.runSettled &&
    event.personal &&
    event.status === RUN_SETTLED_STATUS.completed
  ) {
    return { ...base, kind: "run_completed", sessionId: event.session_id }
  }
  if (
    event.type === SERVER_EVENT_TYPE.sessionActivity &&
    feedsActivityTriggers({
      sessionType: event.session.session_type,
      originAutomationId:
        event.session.origin_automation.kind === LINK.automation
          ? event.session.origin_automation.automation_id
          : null
    })
  ) {
    return { ...base, kind: "activity", sessionId: event.session.session_id }
  }
  return { ...base, kind: "other", sessionId: null }
}
