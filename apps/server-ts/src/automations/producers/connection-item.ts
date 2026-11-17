import type {
  AutomationTriggerEvent,
  ConnectionItemFeedRow
} from "../../persistence/automations/model.js"
import { AutomationTriggers } from "../../persistence/automations/triggers.js"
import type { ConnectionSource } from "../../persistence/connections/store.js"
import type { AutomationEventType } from "@arden-hq/protocol/automations"
import { gmailThreadTarget, hasReadyGmail } from "../../connections/items/gmail.js"
import { calendarEventTarget } from "../../google/calendar-client.js"
import { githubItemUrl } from "../../persistence/connections/item-url.js"
import type { AutomationEventProducer } from "../event-producer.js"

/**
 * The event each stored item's source publishes. A new source adds its entry here; an Automation
 * that listens to every arrival (Urgent events) then hears it with no change of its own.
 */
export const ITEM_EVENT_TYPES = {
  gmail: "email.received",
  github: "github.received",
  calendar: "calendar.changed"
} as const satisfies Record<ConnectionSource, AutomationEventType>

export const connectionItemEvent = (
  row: ConnectionItemFeedRow
): AutomationTriggerEvent | undefined => {
  const item = {
    item_id: row.itemId,
    title: row.title,
    sender: row.sender ?? "",
    received_at: row.receivedAt,
    snippet: row.snippet
  }
  switch (row.source) {
    case "gmail":
      return {
        eventType: ITEM_EVENT_TYPES.gmail,
        eventKey: row.itemId,
        producedBy: null,
        chainDepth: 0,
        touches: { target: gmailThreadTarget(row.threadKey), changedAt: row.receivedAt },
        context: { item }
      }
    case "github": {
      const url = githubItemUrl(row.threadKey)
      return {
        eventType: ITEM_EVENT_TYPES.github,
        eventKey: row.itemId,
        producedBy: null,
        chainDepth: 0,
        context: { item: { ...item, ...(url === undefined ? {} : { url }) } }
      }
    }
    case "calendar":
      return row.detail === undefined
        ? undefined
        : {
            eventType: ITEM_EVENT_TYPES.calendar,
            eventKey: row.itemId,
            producedBy: null,
            chainDepth: 0,
            touches: { target: calendarEventTarget(row.threadKey), changedAt: row.receivedAt },
            context: { event: row.detail }
          }
    default:
      return undefined
  }
}

export const emailItemEventProducer: AutomationEventProducer<"email.received", AutomationTriggers> =
  {
    eventType: "email.received",
    available: ({ googleAccounts }) => googleAccounts.some(hasReadyGmail),
    source: {
      kind: "always",
      poll: AutomationTriggers.use((triggers) => triggers.publishConnectionItems())
    },
    failureMessage: "Connection item event publication remains pending"
  }

export const githubItemEventProducer: AutomationEventProducer<"github.received"> = {
  eventType: "github.received",
  source: { kind: "feed" },
  failureMessage: "GitHub item trigger failed"
}
