import {
  isItemEventType,
  TRIGGER_STATE,
  TRIGGER_TYPE,
  type AutomationTrigger,
  type AutomationTriggerInput,
  type AutomationTriggerSpec
} from "@arden-hq/protocol/automations"
import {
  SYSTEM_PROMPT_EDIT,
  SYSTEM_TRIGGER_SCOPE,
  TRIGGERS_SOURCE,
  type SystemPromptEdit,
  type SystemTriggerScope
} from "./model.js"
import {
  AUTOMATION_CONTEXT_MODE,
  type AutomationContextMode,
  type SystemAutomationSetting
} from "@arden-hq/protocol/automations"
import type { AutomationPatch } from "./automation-patch.js"

export interface SystemAutomationRow {
  readonly name: string
  readonly description: string | null
  readonly prompt: string
  readonly model: string | null
  readonly context_mode: AutomationContextMode
  readonly cooldown_minutes: number | null
  readonly enabled: number
  readonly triggers_source: string | null
  readonly prompt_author: string | null
}

interface SystemSettableSpec {
  readonly contextMode: AutomationContextMode
  readonly promptEdit: SystemPromptEdit
}

export const systemSettable = (
  spec: SystemSettableSpec
): ReadonlyArray<SystemAutomationSetting> => [
  "triggers",
  ...(spec.contextMode === AUTOMATION_CONTEXT_MODE.fork ? [] : (["model"] as const)),
  ...(spec.promptEdit === SYSTEM_PROMPT_EDIT.owner ? (["prompt"] as const) : []),
  "enabled"
]

export const changedSystemSettings = (
  row: SystemAutomationRow,
  spec: { readonly enabled: boolean }
): ReadonlyArray<SystemAutomationSetting> => [
  ...(row.triggers_source === TRIGGERS_SOURCE.manual ? (["triggers"] as const) : []),
  ...(row.model !== null ? (["model"] as const) : []),
  ...(row.prompt_author !== null ? (["prompt"] as const) : []),
  ...((row.enabled === 1) !== spec.enabled ? (["enabled"] as const) : [])
]

type LockedField = Exclude<keyof AutomationPatch, SystemAutomationSetting>

const SPEC_FIELDS = [
  "name",
  "description",
  "cooldown_minutes"
] as const satisfies ReadonlyArray<LockedField>

const USER_FIELDS = ["chat", "history"] as const satisfies ReadonlyArray<LockedField>

export const lockedSystemChanges = (
  row: SystemAutomationRow,
  input: AutomationPatch,
  spec: SystemSettableSpec
): ReadonlyArray<keyof AutomationPatch> => [
  ...SPEC_FIELDS.filter((field) => input[field] !== undefined && input[field] !== row[field]),
  ...(!systemSettable(spec).includes("prompt") &&
  input.prompt !== undefined &&
  input.prompt !== row.prompt
    ? (["prompt"] as const)
    : []),
  ...USER_FIELDS.filter((field) => input[field] !== undefined),
  ...(!systemSettable(spec).includes("model") &&
  input.model !== undefined &&
  input.model !== row.model
    ? (["model"] as const)
    : [])
]

export const lockedSystemMessage = (
  locked: ReadonlyArray<keyof AutomationPatch>,
  spec: SystemSettableSpec
): string =>
  `A system Automation cannot change ${locked.join(", ")}. It accepts only ${systemSettable(spec).join(", ")}.`

export const systemTakesTrigger = (
  spec: { readonly triggerScope: SystemTriggerScope },
  trigger: AutomationTrigger
): boolean => {
  switch (spec.triggerScope) {
    case SYSTEM_TRIGGER_SCOPE.any:
      return true
    case SYSTEM_TRIGGER_SCOPE.item_events:
      return trigger.type === TRIGGER_TYPE.event && isItemEventType(trigger.event_type)
  }
}

export const hasRunOnlyIf = (trigger: AutomationTriggerSpec): boolean =>
  trigger.type === TRIGGER_TYPE.event && trigger.run_only_if.kind === TRIGGER_STATE.sentence

export const defaultTriggerInputs = (
  triggers: ReadonlyArray<AutomationTriggerSpec>
): ReadonlyArray<AutomationTriggerInput> => triggers.map((trigger) => ({ kind: "new", trigger }))
