import type {
  AutomationContextMode,
  SystemAutomationSetting,
  UpdateAutomationInput
} from "@arden-hq/protocol/automations"

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
  readonly runsModel: boolean
}

export const systemSettable = (
  spec: SystemSettableSpec
): ReadonlyArray<SystemAutomationSetting> => [
  "triggers",
  ...(spec.contextMode === "fork" ? [] : (["model"] as const)),
  ...(spec.runsModel ? (["prompt"] as const) : []),
  "enabled"
]

export const changedSystemSettings = (
  row: SystemAutomationRow,
  spec: { readonly enabled: boolean }
): ReadonlyArray<SystemAutomationSetting> => [
  ...(row.triggers_source === "manual" ? (["triggers"] as const) : []),
  ...(row.model !== null ? (["model"] as const) : []),
  ...(row.prompt_author !== null ? (["prompt"] as const) : []),
  ...((row.enabled === 1) !== spec.enabled ? (["enabled"] as const) : [])
]

type LockedField = Exclude<keyof UpdateAutomationInput, SystemAutomationSetting>

const SPEC_FIELDS = [
  "name",
  "description",
  "cooldown_minutes"
] as const satisfies ReadonlyArray<LockedField>

const USER_FIELDS = ["chat", "history"] as const satisfies ReadonlyArray<LockedField>

export const lockedSystemChanges = (
  row: SystemAutomationRow,
  input: UpdateAutomationInput,
  spec: SystemSettableSpec
): ReadonlyArray<keyof UpdateAutomationInput> => [
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
  locked: ReadonlyArray<keyof UpdateAutomationInput>,
  spec: SystemSettableSpec
): string =>
  `A system Automation cannot change ${locked.join(", ")}. It accepts only ${systemSettable(spec).join(", ")}.`
