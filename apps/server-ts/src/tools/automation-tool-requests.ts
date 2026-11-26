import type {
  AutomationChange,
  AutomationChatChoice,
  AutomationCooldown,
  AutomationHistory,
  AutomationModel,
  AutomationTriggerInput,
  AutomationTriggerSpec,
  CreateAutomationInput,
  UpdateAutomationInput
} from "@arden-hq/protocol/automations"
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "@arden-hq/protocol/permissions"
import { ToolExecutionError } from "@arden-hq/loop"
import type { ToolTrigger } from "./automation-tool-trigger-schema.js"
import { CONVERSION, toolTriggerInputs, toolTriggerSpecs } from "./automation-tool-triggers.js"
import { toolFailure } from "./tool-failure.js"

interface ToolAutomationFields {
  readonly description?: string
  readonly model?: string | null
  readonly enabled?: boolean
  readonly cooldown_minutes?: number | null
}

interface ToolCreateFields extends ToolAutomationFields {
  readonly name: string
  readonly prompt: string
  readonly history: AutomationHistory
  readonly triggers: ReadonlyArray<ToolTrigger>
  readonly approval_mode?: ApprovalMode
}

interface ToolUpdateFields extends ToolAutomationFields {
  readonly name?: string
  readonly prompt?: string
  readonly history?: AutomationHistory
  readonly triggers?: ReadonlyArray<ToolTrigger>
}

const createTriggersOf = (
  triggers: ReadonlyArray<ToolTrigger>
): ReadonlyArray<AutomationTriggerSpec> => {
  const specs = toolTriggerSpecs(triggers)
  if (specs.kind === CONVERSION.refused)
    throw new ToolExecutionError(specs.message, { preview: "Settings refused", retryable: false })
  return specs.triggers
}

export const updateTriggersOf = (
  triggers: ReadonlyArray<ToolTrigger>
): ReadonlyArray<AutomationTriggerInput> => {
  const inputs = toolTriggerInputs(triggers)
  if (inputs.kind === CONVERSION.refused)
    throw toolFailure({ reason: "invalid", message: inputs.message }, "Invalid Automation request")
  return inputs.triggers
}

const modelOf = (model: string | null | undefined): AutomationModel =>
  model === undefined || model === null
    ? { kind: "inherited" }
    : { kind: "chosen", model_id: model }

const cooldownOf = (minutes: number | null | undefined): AutomationCooldown =>
  minutes === undefined || minutes === null ? { kind: "none" } : { kind: "minutes", minutes }

export const createRequestOf = (
  input: ToolCreateFields,
  chat: AutomationChatChoice
): CreateAutomationInput => ({
  chat,
  name: input.name,
  prompt: input.prompt,
  description:
    input.description === undefined
      ? { kind: "none" }
      : { kind: "manual", text: input.description },
  model: modelOf(input.model),
  history: input.history,
  triggers: createTriggersOf(input.triggers),
  enabled: input.enabled ?? true,
  approval_mode: input.approval_mode ?? DEFAULT_APPROVAL_MODE,
  cooldown: cooldownOf(input.cooldown_minutes)
})

export const updateRequestOf = (
  input: ToolUpdateFields,
  chat: AutomationChatChoice | undefined
): UpdateAutomationInput => {
  const changes: Array<AutomationChange> = []
  if (chat !== undefined) changes.push({ kind: "chat", chat })
  if (input.name !== undefined) changes.push({ kind: "name", name: input.name })
  if (input.prompt !== undefined) changes.push({ kind: "prompt", prompt: input.prompt })
  if (input.description !== undefined)
    changes.push({ kind: "description", description: input.description })
  if (input.model !== undefined) changes.push({ kind: "model", model: modelOf(input.model) })
  if (input.history !== undefined) changes.push({ kind: "history", history: input.history })
  if (input.triggers !== undefined)
    changes.push({ kind: "triggers", triggers: updateTriggersOf(input.triggers) })
  if (input.enabled !== undefined) changes.push({ kind: "enabled", enabled: input.enabled })
  if (input.cooldown_minutes !== undefined)
    changes.push({ kind: "cooldown", cooldown: cooldownOf(input.cooldown_minutes) })
  return { changes }
}
