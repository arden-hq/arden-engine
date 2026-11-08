import {
  AUTOMATION_EVENT_TYPES,
  AUTOMATION_EVENTS,
  type AutomationEventCatalogEntry,
  type AutomationEventType,
  type EventAutomationTrigger
} from "@arden-hq/protocol/automations"
import { Effect } from "effect"

import type { GoogleConnections } from "../google/service.js"
import type { McpConnections } from "../mcp/service.js"
import type {
  AutomationTriggerEvent,
  JournalReads,
  JournalRecord,
  RaisedEvent
} from "../persistence/automations/model.js"
import type { AutomationEventProducer } from "./event-producer.js"
import { conditionIssue, conditionMatches } from "./events.js"
import { runEndedEventProducer, systemRunEndedEventProducer } from "./producers/automation-run.js"
import { askWaitingEventProducer } from "./producers/ask.js"
import { calendarEventProducer } from "./producers/calendar.js"
import { calendarEndedEventProducer } from "./producers/calendar-ended.js"
import { calendarChangedEventProducer } from "./producers/calendar-changes.js"
import { captureEventProducer } from "./producers/capture.js"
import { chatQuietEventProducer } from "./producers/chat.js"
import { emailItemEventProducer, githubItemEventProducer } from "./producers/connection-item.js"
import { mcpEventProducer } from "./producers/mcp-event.js"
import { taskEventProducer } from "./producers/task.js"
import { wikiEventProducer } from "./producers/wiki.js"

const producers: { readonly [T in AutomationEventType]: AutomationEventProducer<T> } = {
  event_approaching: calendarEventProducer,
  event_ended: calendarEndedEventProducer,
  "calendar.changed": calendarChangedEventProducer,
  "wiki.changed": wikiEventProducer,
  "chat.quiet": chatQuietEventProducer,
  "email.received": emailItemEventProducer,
  "github.received": githubItemEventProducer,
  "task.changed": taskEventProducer,
  "automation.run_ended": runEndedEventProducer,
  "automation.system_run_ended": systemRunEndedEventProducer,
  "capture.arrived": captureEventProducer,
  "ask.waiting": askWaitingEventProducer,
  "mcp.event": mcpEventProducer,
  "space.proposal_review_requested": {
    eventType: "space.proposal_review_requested",
    available: () => false,
    source: { kind: "feed" },
    failureMessage: "Explicit proposal rechecks are queued directly"
  }
}

export const automationEventProducers: ReadonlyArray<AutomationEventProducer> =
  AUTOMATION_EVENT_TYPES.map((type): AutomationEventProducer => producers[type])

export const eventsFromJournal = Effect.fnUntraced(function* (
  record: JournalRecord,
  read: JournalReads
) {
  const raised: Array<RaisedEvent> = []
  for (const producer of automationEventProducers) {
    if (producer.fromJournal !== undefined)
      raised.push(...(yield* producer.fromJournal(record, read)))
  }
  return raised
})

export const eventTriggerIssue = (trigger: EventAutomationTrigger): string | null => {
  if (trigger.event_type === "mcp.event" && trigger.mcp_event === undefined) {
    return "An mcp.event trigger requires mcp_event: the app's server, one event it lists, and its arguments"
  }
  if (trigger.event_type !== "mcp.event" && trigger.mcp_event !== undefined) {
    return `mcp_event belongs only to mcp.event triggers, not ${trigger.event_type}`
  }
  return trigger.condition === undefined || trigger.condition === null
    ? null
    : conditionIssue(AUTOMATION_EVENTS[trigger.event_type], trigger.condition)
}

export const eventTriggerMatches = (
  trigger: EventAutomationTrigger,
  event: AutomationTriggerEvent
): boolean => {
  if (trigger.event_type !== event.eventType) return false
  const accepts = producers[event.eventType].accepts
  if (accepts !== undefined && !accepts(trigger, event)) return false
  return conditionMatches(trigger.condition, event.context)
}

export const availableAutomationEvents = (
  google: GoogleConnections["Service"],
  mcp: McpConnections["Service"]
) =>
  Effect.all([google.list(), mcp.snapshot()]).pipe(
    Effect.map(([response, mcpServers]): ReadonlyArray<AutomationEventCatalogEntry> =>
      automationEventProducers
        .filter(
          (producer) =>
            producer.available?.({ googleAccounts: response.accounts, mcpServers }) ?? true
        )
        .map(({ eventType }) => {
          const event = AUTOMATION_EVENTS[eventType]
          return {
            event_type: event.event_type,
            label: event.label,
            fields: event.fields.map((field) => ({ ...field, operators: [...field.operators] }))
          }
        })
    )
  )
