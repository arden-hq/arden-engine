import type { AutomationEvent } from "@arden-hq/protocol"
import type { ChatEventStore } from "../events/store.js"
import type { InternalLifecycleEvent } from "../sessions/internal-events.js"

export const withCurrentSessionActivity = ({
  event,
  currentActivity
}: {
  readonly event: AutomationEvent | InternalLifecycleEvent
  readonly currentActivity: ChatEventStore["Service"]["currentActivity"]
}): AutomationEvent | InternalLifecycleEvent => {
  if (event.type !== "session_created" && event.type !== "session_activity") return event
  const runId = event.session.active_run_id
  return {
    ...event,
    session: {
      ...event.session,
      current_activity: runId ? (currentActivity(event.session.session_id, runId) ?? null) : null
    }
  }
}
