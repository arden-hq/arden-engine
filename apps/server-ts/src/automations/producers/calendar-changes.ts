import { hasReadyCalendar } from "./calendar.js"
import type { AutomationEventProducer } from "../event-producer.js"

export const calendarChangedEventProducer: AutomationEventProducer<"calendar.changed"> = {
  eventType: "calendar.changed",
  available: ({ googleAccounts }) => googleAccounts.some(hasReadyCalendar),
  source: { kind: "feed" },
  failureMessage: "Calendar change trigger failed"
}
