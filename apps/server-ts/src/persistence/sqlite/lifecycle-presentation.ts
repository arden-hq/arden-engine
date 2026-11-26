import { SERVER_EVENT_TYPE } from "@arden-hq/protocol"
import type { AutomationEvent } from "@arden-hq/protocol"
import { SESSION_RUN } from "@arden-hq/protocol/sessions"
import { sessionActivity } from "../../sessions/session-states.js"
import type { ChatEventStore } from "../events/store.js"
import type { InternalLifecycleEvent } from "../sessions/internal-events.js"

export const withCurrentSessionActivity = ({
  event,
  currentActivity
}: {
  readonly event: AutomationEvent | InternalLifecycleEvent
  readonly currentActivity: ChatEventStore["Service"]["currentActivity"]
}): AutomationEvent | InternalLifecycleEvent => {
  if (
    event.type !== SERVER_EVENT_TYPE.sessionCreated &&
    event.type !== SERVER_EVENT_TYPE.sessionActivity
  )
    return event
  const run = event.session.run
  return {
    ...event,
    session: {
      ...event.session,
      current_activity: sessionActivity(
        run.kind === SESSION_RUN.active
          ? currentActivity(event.session.session_id, run.run_id)
          : undefined
      )
    }
  }
}
