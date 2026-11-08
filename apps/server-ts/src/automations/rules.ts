import { DateTime, Layer } from "effect"
import { AutomationRules } from "../persistence/automations/model.js"
import { eventsFromJournal, eventTriggerMatches } from "./event-producers.js"
import { automationRunEndedEvent } from "./producers/automation-run.js"
import { chatQuietEvent } from "./producers/chat.js"
import { connectionItemEvent } from "./producers/connection-item.js"
import { nextScheduleRunAt, oneShotSchedule, personalAutomationTriggers } from "./schedule.js"
import { handlerItemOwner, systemSpec } from "./system.js"

export const automationRulesLayer: Layer.Layer<AutomationRules> = Layer.succeed(
  AutomationRules,
  AutomationRules.of({
    triggers: personalAutomationTriggers,
    nextRunAt: (schedule, afterMs) =>
      nextScheduleRunAt(schedule, { afterMs, zone: DateTime.zoneMakeLocal() }),
    oneShot: oneShotSchedule,
    eventMatches: eventTriggerMatches,
    itemOwner: handlerItemOwner,
    systemSpec,
    chatQuietEvent,
    runEndedEvent: automationRunEndedEvent,
    connectionItemEvent,
    fromJournal: eventsFromJournal
  })
)
