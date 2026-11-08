import { ToolExecutionError } from "@arden-hq/loop"
import { countOf } from "@arden-hq/std/count"
import {
  AUTOMATION_ACTIVITY_TRIGGERS,
  AUTOMATION_EVENTS,
  automationEnabledWord,
  DEFAULT_EVENT_LEAD_MINUTES,
  eventLeadWords,
  mergeTriggerInputs,
  type Automation,
  type AutomationEventLink,
  type AutomationOldCondition,
  type AutomationTrigger,
  type AutomationTriggerInput
} from "@arden-hq/protocol/automations"
import { oldConditions } from "../persistence/automations/event-words.js"

export const requireAutomationRef = (automation: Automation): string => {
  if (automation.automation_ref !== undefined) return automation.automation_ref
  throw new ToolExecutionError("A stored Automation is missing its public reference", {
    preview: "Automation data is corrupt",
    retryable: false
  })
}

const triggerWords = (
  trigger: AutomationTrigger | AutomationTriggerInput,
  oldWords: ReadonlyMap<string, AutomationOldCondition>,
  audience: "agent" | "card"
): string => {
  const id = audience === "agent" && trigger.id !== undefined ? `${trigger.id}: ` : ""
  return `${id}${triggerHead(trigger, audience)}${eventFields(trigger, oldWords, audience)}`
}

const triggerHead = (
  trigger: AutomationTrigger | AutomationTriggerInput,
  audience: "agent" | "card"
): string => {
  switch (trigger.type) {
    case "time": {
      const cadence = trigger.at === undefined ? `every ${trigger.every}` : `at ${trigger.at}`
      const days = trigger.on ?? trigger.days
      const window =
        trigger.start === undefined || trigger.end === undefined
          ? ""
          : ` between ${trigger.start}-${trigger.end}`
      return `${cadence}${days === undefined ? "" : ` on ${days}`}${window}`
    }
    case "idle":
      return AUTOMATION_ACTIVITY_TRIGGERS.idle.summary(trigger.idle_minutes)
    case "count":
      return AUTOMATION_ACTIVITY_TRIGGERS.count.summary(trigger.every_n)
    case "event": {
      const app = trigger.mcp_event
      if (trigger.event_type === "mcp.event" && app !== undefined && app !== null) {
        const filters =
          app.arguments === undefined || Object.keys(app.arguments).length === 0
            ? ""
            : ` ${JSON.stringify(app.arguments)}`
        return audience === "agent"
          ? `mcp.event (${app.server}/${app.event}${filters})`
          : `${app.server}: ${app.event}`
      }
      const lead =
        trigger.event_type === "event_approaching"
          ? eventLeadWords(trigger.lead_minutes ?? DEFAULT_EVENT_LEAD_MINUTES)
          : AUTOMATION_EVENTS[trigger.event_type].name
      return audience === "agent" ? `${trigger.event_type} (${lead})` : lead
    }
  }
}

const eventFields = (
  trigger: AutomationTrigger | AutomationTriggerInput,
  oldWords: ReadonlyMap<string, AutomationOldCondition>,
  audience: "agent" | "card"
): string => {
  if (trigger.type !== "event") return ""
  const sentence =
    trigger.run_only_if === undefined || trigger.run_only_if === null
      ? ""
      : `, run only if: "${trigger.run_only_if}"`
  const old = trigger.id === undefined ? undefined : oldWords.get(trigger.id)
  const condition =
    old === undefined
      ? ""
      : `, old condition: ${old.words}${
          audience === "agent" && !old.readable ? " (some of its fields have no words)" : ""
        }`
  return `${sentence}${condition}`
}

const byTrigger = (
  conditions: ReadonlyArray<AutomationOldCondition>
): ReadonlyMap<string, AutomationOldCondition> =>
  new Map(conditions.map((condition) => [condition.trigger_id, condition]))

export const triggersLabel = (
  automation: Pick<Automation, "triggers" | "old_conditions">,
  indent: string
): string =>
  automation.triggers
    .map(
      (trigger) =>
        `${indent}${triggerWords(trigger, byTrigger(automation.old_conditions), "agent")}`
    )
    .join("\n")

export const droppedTriggerLines = (
  current: Pick<Automation, "triggers" | "old_conditions">,
  sent: ReadonlyArray<AutomationTriggerInput>,
  indent: string
): ReadonlyArray<string> => {
  const merged = mergeTriggerInputs({ triggers: current.triggers, lastId: 0 }, sent)
  if (merged.kind !== "ok") return []
  const old = byTrigger(current.old_conditions)
  return merged.dropped.map((dropped) => {
    switch (dropped.field) {
      case "run_only_if":
        return `${indent}${dropped.id}: run only if "${dropped.value}"`
      case "condition":
        return `${indent}${dropped.id}: old condition ${old.get(dropped.id)?.words ?? "(no words)"}`
    }
  })
}

export const triggerInputWords = (
  triggers: ReadonlyArray<AutomationTrigger | AutomationTriggerInput>
): string => {
  const old = byTrigger(oldConditions(triggers))
  return triggers.map((trigger) => triggerWords(trigger, old, "card")).join(" or ")
}

export const historyLabel = (automation: Automation): string => {
  switch (automation.history) {
    case "fresh":
      return "starts fresh"
    case "chat":
      return "reads the chat"
    case null:
      return "set by the system"
  }
}

export const chatLabel = (
  automation: Automation,
  info: AutomationModelInfo,
  currentSessionId: string
): string => {
  if (automation.chat === null) return "none"
  if (automation.chat.kind === "own") return "its own chat"
  if (automation.chat.session_id === currentSessionId) return "this chat"
  return info.chat_ref ?? "one of your chats"
}

export const modelLabel = (info: AutomationModelInfo): string =>
  info.model_source === "source_chat"
    ? "each chat's own model"
    : `${info.effective_model ?? "unknown"} (${info.model_source})`

export const SYSTEM_ACCEPTS =
  "A system Automation accepts only triggers, model, prompt, enabled and plan limits; a fork (Chat summaries) runs on each chat's model, so it has no model to change, and a job that runs no model has no prompt."

export const systemLines = (automation: Automation): ReadonlyArray<string> => {
  const system = automation.system
  if (system === null) return []
  return [
    `  Accepts: ${system.settable.join(", ")}, plan limits${automation.manual_run ? "" : " · no manual run"}`,
    `  Changed from default: ${system.changed.length === 0 ? "nothing" : system.changed.join(", ")}`,
    ...(system.changed.includes("triggers")
      ? [
          "  Default triggers:",
          triggersLabel({ triggers: system.default_triggers, old_conditions: [] }, "    ")
        ]
      : [])
  ]
}

export type AutomationModelInfo = {
  readonly model_source: "override" | "chat" | "source_chat" | "background" | "unknown"
  readonly effective_model: string | null
  readonly chat_ref: string | null
  readonly action_mode: string | null
}

export const scheduleStatus = (automation: Automation): string =>
  automationEnabledWord(automation.enabled)

const currentRunStatus = (automation: Automation): string => {
  if (automation.waiting_on === "approval") return " · paused for an approval"
  if (automation.waiting_on === "connection") return " · paused for a reconnect"
  if (automation.running_since !== null) return " · current run active"
  return ""
}

export const formatAutomation = (
  automation: Automation,
  modelInfo: AutomationModelInfo,
  currentSessionId: string
): string => {
  const ref = requireAutomationRef(automation)
  const builtin = automation.builtin ? " [system]" : ""
  return [
    `[${ref}] ${automation.name}${builtin}`,
    `  Schedule: ${scheduleStatus(automation)}${currentRunStatus(automation)}`,
    ...(automation.waiting_events > 0
      ? [`  Waiting: ${countOf(automation.waiting_events, "event")}`]
      : []),
    "  Triggers:",
    triggersLabel(automation, "    "),
    ...(automation.system === null
      ? [
          `  Chat: ${chatLabel(automation, modelInfo, currentSessionId)}`,
          `  History: ${historyLabel(automation)}`
        ]
      : []),
    `  Model: ${modelLabel(modelInfo)}`,
    `  Action mode: ${modelInfo.action_mode ?? "inherited"}`,
    ...systemLines(automation),
    `  next: ${automation.next_run_at ?? "none"} · last: ${automation.last_run_at ?? "never"}`
  ].join("\n")
}

export const skippedEventCall = (link: AutomationEventLink | null): string | undefined => {
  if (link === null) return undefined
  switch (link.kind) {
    case "chat":
      return `session_read(session_ref=${JSON.stringify(link.session_ref)})`
    case "memory_page":
      return `wiki_read_page(path=${JSON.stringify(link.path)})`
    case "task":
      return `task_get(item_id=${JSON.stringify(link.item_id)})`
    case "connection_item":
      return `connection_item_read(item_id=${JSON.stringify(link.item_id)})`
  }
}
