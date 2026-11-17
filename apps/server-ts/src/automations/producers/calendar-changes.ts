import { hasReadyCalendar } from "./calendar.js"
import type { AutomationEventProducer } from "../event-producer.js"

/** Calendar changes are stored as items by the items fetch
 *  (`connections/items/calendar.ts`) and published from there. */
export const calendarChangedEventProducer: AutomationEventProducer<"calendar.changed"> = {
  eventType: "calendar.changed",
  available: ({ googleAccounts }) => googleAccounts.some(hasReadyCalendar),
  source: { kind: "feed" },
  failureMessage: "Calendar change trigger failed"
}
