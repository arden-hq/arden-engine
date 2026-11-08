import type {
  AutomationTriggerEvent,
  ConnectionItemFeedRow
} from "../../persistence/automations/model.js"
import { AutomationTriggers } from "../../persistence/automations/triggers.js"
import { gmailThreadTarget, hasReadyGmail } from "../../connections/items/gmail.js"
import { githubItemUrl } from "../../persistence/connections/item-url.js"
import type { AutomationEventProducer } from "../event-producer.js"

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
        eventType: "email.received",
        eventKey: row.itemId,
        producedBy: null,
        chainDepth: 0,
        touches: { target: gmailThreadTarget(row.threadKey), changedAt: row.receivedAt },
        context: { item }
      }
    case "github": {
      const url = githubItemUrl(row.threadKey)
      return {
        eventType: "github.received",
        eventKey: row.itemId,
        producedBy: null,
        chainDepth: 0,
        context: { item: { ...item, ...(url === undefined ? {} : { url }) } }
      }
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
