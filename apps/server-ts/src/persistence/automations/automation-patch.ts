import type {
  AutomationChange,
  AutomationChatChoice,
  AutomationCooldown,
  AutomationHistory,
  AutomationModel,
  AutomationTriggerInput
} from "@arden-hq/protocol/automations"
import {
  AutomationChangeSchema,
  AutomationCooldownSchema,
  AutomationModelSchema
} from "@arden-hq/protocol/effect/automations"

export interface AutomationPatch {
  readonly chat?: AutomationChatChoice
  readonly name?: string
  readonly prompt?: string
  readonly description?: string
  readonly model?: string | null
  readonly history?: AutomationHistory
  readonly triggers?: ReadonlyArray<AutomationTriggerInput>
  readonly enabled?: boolean
  readonly cooldown_minutes?: number | null
}

export const modelIdOf = (model: AutomationModel): string | null =>
  AutomationModelSchema.match(model, { inherited: () => null, chosen: ({ model_id }) => model_id })

export const cooldownMinutesOf = (cooldown: AutomationCooldown): number | null =>
  AutomationCooldownSchema.match(cooldown, { none: () => null, minutes: ({ minutes }) => minutes })

const changePatch = AutomationChangeSchema.match({
  chat: ({ chat }): AutomationPatch => ({ chat }),
  name: ({ name }): AutomationPatch => ({ name }),
  prompt: ({ prompt }): AutomationPatch => ({ prompt }),
  description: ({ description }): AutomationPatch => ({ description }),
  model: ({ model }): AutomationPatch => ({ model: modelIdOf(model) }),
  history: ({ history }): AutomationPatch => ({ history }),
  triggers: ({ triggers }): AutomationPatch => ({ triggers }),
  enabled: ({ enabled }): AutomationPatch => ({ enabled }),
  cooldown: ({ cooldown }): AutomationPatch => ({ cooldown_minutes: cooldownMinutesOf(cooldown) })
})

export const automationPatch = (changes: ReadonlyArray<AutomationChange>): AutomationPatch =>
  changes.reduce<AutomationPatch>((patch, change) => ({ ...patch, ...changePatch(change) }), {})
