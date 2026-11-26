import type {
  Automation,
  AutomationHistory,
  AutomationOldCondition,
  AutomationRunStatus,
  AutomationWaitingOn,
  SystemAutomationSettings
} from "@arden-hq/protocol/automations"
import {
  AutomationActivitySchema,
  AutomationCooldownSchema,
  AutomationDescriptionSchema,
  AutomationLastResultSchema,
  AutomationLastRunSchema,
  AutomationModelSchema,
  AutomationNextRunSchema,
  AutomationSchema,
  SystemAutomationChatSchema
} from "@arden-hq/protocol/effect/automations"
import type { AutomationModelInfo } from "./automation-tool-text.js"
import { triggerRecord, type TriggerRecord } from "../persistence/automations/trigger-record.js"

export const descriptionText = (automation: Pick<Automation, "description">): string | null =>
  AutomationDescriptionSchema.match(automation.description, {
    none: () => null,
    manual: ({ text }) => text,
    generated: ({ text }) => text
  })

export const modelId = (automation: Pick<Automation, "model">): string | null =>
  AutomationModelSchema.match(automation.model, {
    inherited: () => null,
    chosen: ({ model_id }) => model_id
  })

export const cooldownMinutes = (automation: Pick<Automation, "cooldown">): number | null =>
  AutomationCooldownSchema.match(automation.cooldown, {
    none: () => null,
    minutes: ({ minutes }) => minutes
  })

export const historyOf = (automation: Automation): AutomationHistory | null =>
  AutomationSchema.guards.user(automation) ? automation.history : null

export const nextRunAt = (automation: Pick<Automation, "next_run">): string | null =>
  AutomationNextRunSchema.match(automation.next_run, {
    unscheduled: () => null,
    scheduled: ({ at }) => at
  })

export const lastRunAt = (automation: Pick<Automation, "last_run">): string | null =>
  AutomationLastRunSchema.match(automation.last_run, { never: () => null, ran: ({ at }) => at })

export const isRunning = (automation: Pick<Automation, "activity">): boolean =>
  !AutomationActivitySchema.guards.idle(automation.activity)

type AutomationToolData = AutomationModelInfo & {
  readonly automation_ref: string
  readonly name: string
  readonly description: string | null
  readonly prompt: string
  readonly model: string | null
  readonly chat: "own" | "yours" | null
  readonly history: AutomationHistory | null
  readonly handler: string | null
  readonly triggers: ReadonlyArray<TriggerRecord>
  readonly enabled: boolean
  readonly created_at: string
  readonly last_run_at: string | null
  readonly next_run_at: string | null
  readonly recent_statuses: ReadonlyArray<AutomationRunStatus>
  readonly last_result: string | null
  readonly running_since: string | null
  readonly waiting_on: AutomationWaitingOn | null
  readonly waiting_events: number
  readonly builtin: boolean
  readonly cooldown_minutes: number | null
  readonly old_conditions: ReadonlyArray<AutomationOldCondition>
  readonly manual_run: boolean
  readonly system: SystemAutomationSettings | null
}

export const automationData = (
  automation: Automation,
  modelInfo: AutomationModelInfo
): AutomationToolData => {
  const system = AutomationSchema.guards.system(automation) ? automation : undefined
  const activity = automation.activity
  return {
    automation_ref: automation.automation_ref,
    name: automation.name,
    description: descriptionText(automation),
    prompt: automation.prompt,
    model: modelId(automation),
    chat: SystemAutomationChatSchema.guards.none(automation.chat) ? null : automation.chat.kind,
    history: historyOf(automation),
    ...modelInfo,
    handler: system?.handler ?? null,
    triggers: automation.triggers.map(triggerRecord),
    enabled: automation.enabled,
    created_at: automation.created_at,
    last_run_at: lastRunAt(automation),
    next_run_at: nextRunAt(automation),
    recent_statuses: automation.recent_statuses,
    last_result: AutomationLastResultSchema.match(automation.last_result, {
      none: () => null,
      text: ({ text }) => text
    }),
    running_since: AutomationActivitySchema.guards.idle(activity) ? null : activity.since,
    waiting_on: AutomationActivitySchema.guards.waiting(activity) ? activity.on : null,
    waiting_events: automation.waiting_events,
    builtin: automation.builtin,
    cooldown_minutes: cooldownMinutes(automation),
    old_conditions: automation.old_conditions,
    manual_run: system?.manual_run ?? true,
    system: system?.settings ?? null
  }
}
