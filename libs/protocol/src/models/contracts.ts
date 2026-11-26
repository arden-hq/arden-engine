import type { JsonRecord } from "../common/json.js"

export type ModelRole = "background" | "helper"

/** What "Restore defaults" on one page puts back: the chat model and its
 *  remembered efforts, or the background and helper models. */
export type ModelResetScope = "chat" | "roles"

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

/** Models selectable in the desktop, grouped by provider. */
export interface ModelCatalog extends JsonRecord {
  readonly providers: ReadonlyArray<ModelProvider>
}

export interface ModelAssignment extends JsonRecord {
  readonly modelId: string | null
  readonly reasoningEffort: string | null
}

/** Model-owned projection of the otherwise broad `GET /config` response. */
export interface ModelSettings {
  readonly chat: ModelAssignment
  readonly roles: Readonly<Record<ModelRole, ModelAssignment>>
}

/** Consumer projection decoded from the broad `GET /config` response. */
export interface ModelSettingsResponse extends ModelSettings {
  /** Supported efforts for the selected Chat model. */
  readonly chatReasoningEfforts: ReadonlyArray<string>
  /** Remembered per-model effort choices, including currently unselected models. */
  readonly reasoningByModel: Readonly<Record<string, string>>
  /** Stored settings equal the bundled host's factory defaults. Only the
   *  server knows those, so it says so; `POST /config/models/reset` restores one scope of them. */
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
  | { readonly kind: "default" }
  | { readonly kind: "effort"; readonly effort: string }

export type ModelSettingsChange =
  | {
      readonly kind: "chat_model"
      readonly model:
        | { readonly kind: "none" }
        | { readonly kind: "model"; readonly modelId: string }
    }
  | {
      readonly kind: "model_reasoning"
      readonly modelId: string
      readonly reasoning: ReasoningTarget
    }
  | {
      readonly kind: "role_model"
      readonly role: ModelRole
      readonly model:
        | { readonly kind: "chat" }
        | { readonly kind: "model"; readonly modelId: string }
    }
  | {
      readonly kind: "role_reasoning"
      readonly role: ModelRole
      readonly reasoning: ReasoningTarget
    }

export type ModelSettingsPatch = ReadonlyArray<ModelSettingsChange>
