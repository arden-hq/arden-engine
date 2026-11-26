import {
  APP_EVENT,
  type EventAutomationTrigger,
  type McpEventSelector
} from "@arden-hq/protocol/automations"
import { MCP_CONNECTION_STATUS } from "@arden-hq/protocol/mcp"
import { Effect } from "effect"

import { engineOrderedJson } from "@arden-hq/std/json"
import { McpEvents, type McpEventSubscription } from "../../mcp/events/subscriptions.js"
import type { McpEventOccurrence } from "../../mcp/events/wire.js"
import type { AutomationTriggerEvent } from "../../persistence/automations/model.js"
import { AutomationTriggers } from "../../persistence/automations/triggers.js"
import { AUTOMATION_EVENT_SOURCE, type AutomationEventProducer } from "../event-producer.js"
import { readField } from "../events.js"
import { sha256Hex } from "@arden-hq/std/hash"

const MAX_DATA_BYTES = 32 * 1_024

const mcpEventSource = (selector: McpEventSelector): string =>
  `${selector.server}/${selector.event}/${sha256Hex(engineOrderedJson(selector.arguments)).slice(
    0,
    16
  )}`

const mcpAppEvent = (
  subscription: McpEventSubscription,
  occurrence: McpEventOccurrence
): AutomationTriggerEvent => {
  const dataBytes = Buffer.byteLength(JSON.stringify(occurrence.data), "utf8")
  return {
    eventType: "mcp.event",
    eventKey: `${subscription.server}:${subscription.event}:${occurrence.eventId}`,
    producedBy: null,
    chainDepth: 0,
    context: {
      app: {
        server: subscription.server,
        event: subscription.event,
        source: subscription.key,
        event_id: occurrence.eventId,
        at: occurrence.timestamp,
        ...(dataBytes > MAX_DATA_BYTES
          ? { data_omitted_bytes: dataBytes }
          : { data: occurrence.data })
      }
    }
  }
}

const subscriptionsOf = (
  triggers: ReadonlyArray<EventAutomationTrigger>
): ReadonlyArray<McpEventSubscription> => {
  const bySource = new Map<string, McpEventSubscription>()
  for (const trigger of triggers) {
    if (trigger.event_type !== APP_EVENT) continue
    const selector = trigger.mcp_event
    const key = mcpEventSource(selector)
    bySource.set(key, {
      key,
      server: selector.server,
      event: selector.event,
      arguments: selector.arguments
    })
  }
  return [...bySource.values()]
}

export const mcpEventProducer: AutomationEventProducer<
  "mcp.event",
  AutomationTriggers | McpEvents
> = {
  eventType: "mcp.event",
  available: ({ mcpServers }) =>
    mcpServers.some(
      (server) => server.status === MCP_CONNECTION_STATUS.connected && server.events.length > 0
    ),
  accepts: (trigger, event) =>
    trigger.event_type === APP_EVENT &&
    readField(event.context, "app.source") === mcpEventSource(trigger.mcp_event),
  source: {
    kind: AUTOMATION_EVENT_SOURCE.live,
    follow: Effect.fnUntraced(function* (triggers) {
      const events = yield* McpEvents
      const store = yield* AutomationTriggers
      const subscriptions = subscriptionsOf(triggers)
      yield* events.follow(subscriptions, {
        cursor: (subscription) =>
          store.readSourceCursor({ eventType: "mcp.event", source: subscription.key }),
        deliver: (subscription, batch) =>
          store
            .publishSourceEvents({
              eventType: "mcp.event",
              source: subscription.key,
              events: batch.occurrences.map((occurrence) => mcpAppEvent(subscription, occurrence)),
              cursor: batch.cursor
            })
            .pipe(Effect.asVoid)
      })
      return subscriptions.map((subscription) => subscription.key)
    })
  },
  failureMessage: "App event subscriptions could not be updated"
}
