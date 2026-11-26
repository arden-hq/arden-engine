import type {
  AutomationTriggerEvent,
  ConnectionItemFeedRow
} from "../../persistence/automations/model.js"
import { AutomationTriggers } from "../../persistence/automations/triggers.js"
import type { ConnectionSource } from "../../persistence/connections/store.js"
import { AUTOMATION_EVENT_TYPE } from "@arden-hq/protocol/automations"
import { isSignalSource } from "@arden-hq/protocol/signals"
import { gmailThreadTarget, hasReadyGmail, SENT_BY_OWNER } from "../../connections/items/gmail.js"
import { calendarEventTarget } from "../../google/calendar-client.js"
import { githubItemUrl } from "../../persistence/connections/item-url.js"
import type { AutomationEventProducer } from "../event-producer.js"

type ItemFields = {
  readonly item_id: string
  readonly title: string
  readonly sender: string
  readonly received_at: string
  readonly snippet: string
}

const ITEM_EVENTS: {
  readonly [S in ConnectionSource]: (
    row: ConnectionItemFeedRow,
    item: ItemFields
  ) => AutomationTriggerEvent | undefined
} = {
  gmail: (row, item) =>
    row.detail?.[SENT_BY_OWNER] === true
      ? undefined
      : {
          eventType: AUTOMATION_EVENT_TYPE.email_received,
          eventKey: row.itemId,
          producedBy: null,
          chainDepth: 0,
          touches: { target: gmailThreadTarget(row.threadKey), changedAt: row.receivedAt },
          context: { item }
        },
  github: (row, item) => {
    const url = githubItemUrl(row.threadKey)
    return {
      eventType: AUTOMATION_EVENT_TYPE.github_received,
      eventKey: row.itemId,
      producedBy: null,
      chainDepth: 0,
      context: { item: { ...item, ...(url === undefined ? {} : { url }) } }
    }
  },
  calendar: (row) =>
    row.detail === undefined
      ? undefined
      : {
          eventType: AUTOMATION_EVENT_TYPE.calendar_changed,
          eventKey: row.itemId,
          producedBy: null,
          chainDepth: 0,
          touches: { target: calendarEventTarget(row.threadKey), changedAt: row.receivedAt },
          context: { event: row.detail }
        }
}

export const connectionItemEvent = (
  row: ConnectionItemFeedRow
): AutomationTriggerEvent | undefined =>
  isSignalSource(row.source)
    ? ITEM_EVENTS[row.source](row, {
        item_id: row.itemId,
        title: row.title,
        sender: row.sender ?? "",
        received_at: row.receivedAt,
        snippet: row.snippet
      })
    : undefined

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
