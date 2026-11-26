import type { JsonRecord } from "../common/json.js"

export const MODEL_ROLE = { background: "background", helper: "helper" } as const

export type ModelRole = (typeof MODEL_ROLE)[keyof typeof MODEL_ROLE]

export const MODEL_RESET_SCOPE = { chat: "chat", roles: "roles" } as const

export type ModelResetScope = (typeof MODEL_RESET_SCOPE)[keyof typeof MODEL_RESET_SCOPE]

export interface ModelOption extends JsonRecord {
  readonly id: string
  readonly name: string
  readonly reasoningEfforts: ReadonlyArray<string>
}

export interface ModelProvider extends JsonRecord {
  readonly id: string
  readonly name: string
  readonly models: ReadonlyArray<ModelOption>
}

export interface ModelCatalog extends JsonRecord {
  readonly providers: ReadonlyArray<ModelProvider>
}

export interface ModelAssignment extends JsonRecord {
  readonly modelId: string | null
  readonly reasoningEffort: string | null
}

export interface ModelSettings {
  readonly chat: ModelAssignment
  readonly roles: Readonly<Record<ModelRole, ModelAssignment>>
}

export interface ModelSettingsResponse extends ModelSettings {
  readonly chatReasoningEfforts: ReadonlyArray<string>
  readonly reasoningByModel: Readonly<Record<string, string>>
  readonly atDefaults: Readonly<Record<ModelResetScope, boolean>>
}

export const MODEL_TARGET = { none: "none", chat: "chat", model: "model" } as const
export const REASONING_TARGET = { default: "default", effort: "effort" } as const
export const MODEL_SETTINGS_CHANGE = {
  chatModel: "chat_model",
  modelReasoning: "model_reasoning",
  roleModel: "role_model",
  roleReasoning: "role_reasoning"
} as const

export type ReasoningTarget =
  | { readonly kind: typeof REASONING_TARGET.default }
  | { readonly kind: typeof REASONING_TARGET.effort; readonly effort: string }

export type ModelSettingsChange =
  | {
      readonly kind: typeof MODEL_SETTINGS_CHANGE.chatModel
      readonly model:
        | { readonly kind: typeof MODEL_TARGET.none }
        | { readonly kind: typeof MODEL_TARGET.model; readonly modelId: string }
    }
  | {
      readonly kind: typeof MODEL_SETTINGS_CHANGE.modelReasoning
      readonly modelId: string
      readonly reasoning: ReasoningTarget
    }
  | {
      readonly kind: typeof MODEL_SETTINGS_CHANGE.roleModel
      readonly role: ModelRole
      readonly model:
        | { readonly kind: typeof MODEL_TARGET.chat }
        | { readonly kind: typeof MODEL_TARGET.model; readonly modelId: string }
    }
  | {
      readonly kind: typeof MODEL_SETTINGS_CHANGE.roleReasoning
      readonly role: ModelRole
      readonly reasoning: ReasoningTarget
    }

export type ModelSettingsPatch = ReadonlyArray<ModelSettingsChange>
