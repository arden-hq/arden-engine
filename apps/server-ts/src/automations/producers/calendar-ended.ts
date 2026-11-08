import { DateTime, Effect } from "effect"

import type { AutomationTriggerEvent } from "../../persistence/automations/model.js"
import { AutomationTriggers } from "../../persistence/automations/triggers.js"
import type { GoogleConnections } from "../../google/service.js"
import type { AutomationEventProducer } from "../event-producer.js"
import {
  calendarEventContext,
  calendarEventId,
  hasReadyCalendar,
  pollCalendarEvents,
  type PolledCalendarEvent
} from "./calendar.js"

const ENDED_LOOKBACK_MS = 30 * 60_000

const endedEvents = (input: PolledCalendarEvent): ReadonlyArray<AutomationTriggerEvent> => {
  const { event, nowMs } = input
  if (event.status === "cancelled") return []
  const endValue = event.end?.dateTime
  if (endValue === undefined) return []
  const ended = DateTime.make(endValue)
  if (ended._tag === "None") return []
  const endMs = DateTime.toEpochMillis(ended.value)
  if (endMs > nowMs || endMs <= nowMs - ENDED_LOOKBACK_MS) return []
  const end = DateTime.formatIso(ended.value)
  const started =
    event.start.dateTime === undefined ? undefined : DateTime.make(event.start.dateTime)
  return [
    {
      eventType: "event_ended",
      eventKey: `${calendarEventId(input)}:${end}`,
      producedBy: null,
      chainDepth: 0,
      context: {
        event: calendarEventContext(input, {
          ...(started?._tag === "Some" ? { start: DateTime.formatIso(started.value) } : {}),
          end,
          minutes_since_end: Math.max(0, Math.floor((nowMs - endMs) / 60_000))
        })
      }
    }
  ]
}

const pollEnded = Effect.fn("AutomationTriggerProducers.pollCalendarEnded")(function* () {
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
  return yield* pollCalendarEvents({
    fromMs: nowMs - ENDED_LOOKBACK_MS,
    toMs: nowMs,
    toEvents: endedEvents
  })
})

export const calendarEndedEventProducer: AutomationEventProducer<
  "event_ended",
  GoogleConnections | AutomationTriggers
> = {
  eventType: "event_ended",
  available: ({ googleAccounts }) => googleAccounts.some(hasReadyCalendar),
  source: { kind: "on_demand", poll: () => pollEnded() },
  failureMessage: "Google Calendar ended-event trigger producer failed"
}
