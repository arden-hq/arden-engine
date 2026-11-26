import type {
  AutomationChange,
  AutomationTriggerInput,
  AutomationTriggerSpec,
  CreateAutomationInput,
  EventTriggerSpec,
  PlainEventType,
  TimeTriggerSpec,
  UpdateAutomationInput
} from "@arden-hq/protocol/automations"
import { DEFAULT_APPROVAL_MODE } from "@arden-hq/protocol/permissions"

type NewAutomation = Pick<CreateAutomationInput, "name" | "prompt" | "history" | "triggers"> &
  Partial<CreateAutomationInput> & { readonly idempotency_key: string }

export const newAutomation = (
  input: NewAutomation
): CreateAutomationInput & {
  readonly idempotency_key: string
  readonly idempotency_scope: "global"
} => ({
  chat: { kind: "own" },
  description: { kind: "none" },
  model: { kind: "inherited" },
  enabled: true,
  approval_mode: DEFAULT_APPROVAL_MODE,
  cooldown: { kind: "none" },
  ...input,
  idempotency_scope: "global"
})

export const changes = (...list: ReadonlyArray<AutomationChange>): UpdateAutomationInput => ({
  changes: list
})

export const everyTrigger = (every: string): TimeTriggerSpec => ({
  type: "time",
  schedule: { kind: "interval", every, days: { kind: "every_day" }, window: { kind: "all_day" } }
})

export const eventTrigger = (event_type: PlainEventType): EventTriggerSpec => ({
  type: "event",
  event_type,
  run_only_if: { kind: "any_event" },
  condition: { kind: "none" }
})

export const sentenceTrigger = (
  event_type: PlainEventType,
  sentence: string
): EventTriggerSpec => ({
  type: "event",
  event_type,
  run_only_if: { kind: "sentence", sentence },
  condition: { kind: "none" }
})

export const newTriggers = (
  ...triggers: ReadonlyArray<AutomationTriggerSpec>
): ReadonlyArray<AutomationTriggerInput> => triggers.map((trigger) => ({ kind: "new", trigger }))
