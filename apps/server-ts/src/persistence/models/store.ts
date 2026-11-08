import { storeErrorFields } from "../errors.js"
import type {
  ModelAssignment,
  ModelResetScope,
  ModelRole,
  ModelSettings,
  ModelSettingsPatch
} from "@arden-hq/protocol/models"
import type { HistoryResponse } from "@arden-hq/protocol/chat"

export type ModelContextBudget = HistoryResponse["context_budget"] & {
  readonly model: string
  readonly hard_limit: number
  readonly compaction_trigger: number
}
import { Context, Effect, Schema } from "effect"

export type ModelStoreOperation =
  | "catalog"
  | "settings"
  | "patch"
  | "reset"
  | "set_session_model"
  | "selection"
  | "context_budget"

export class ModelStoreError extends Schema.TaggedError<ModelStoreError>()("ModelStoreError", {
  ...storeErrorFields({
    operations: [
      "catalog",
      "settings",
      "patch",
      "reset",
      "set_session_model",
      "selection",
      "context_budget"
    ],
    reasons: ["invalid", "not_found", "conflict", "unavailable", "storage"]
  }),
  sessionId: Schema.optionalKey(Schema.NonEmptyString)
}) {}

export interface ModelContextBudgetInput {
  readonly modelId: string | null
  readonly inputTokens: number
  readonly messageCount: number
}

export interface SessionModelSelection extends ModelAssignment {
  readonly sessionId: string
  readonly overrideModelId: string | null
}

export interface ModelSettingsSnapshot {
  readonly effective: ModelSettings
  readonly atDefaults: Readonly<Record<ModelResetScope, boolean>>
  readonly chatModelId: string | null
  readonly modelReasoningEfforts: Readonly<Record<string, string>>
  readonly roleOverrides: Readonly<Record<ModelRole, ModelAssignment>>
}

export class ModelStore extends Context.Service<
  ModelStore,
  {
    readonly snapshot: () => Effect.Effect<ModelSettingsSnapshot, ModelStoreError>
    readonly patch: (
      input: ModelSettingsPatch
    ) => Effect.Effect<ModelSettingsSnapshot, ModelStoreError>
    readonly reset: (
      scope: ModelResetScope
    ) => Effect.Effect<ModelSettingsSnapshot, ModelStoreError>
    readonly setSessionModel: (
      sessionId: string,
      modelId: string | null
    ) => Effect.Effect<SessionModelSelection, ModelStoreError>
    readonly roleSelection: (role: ModelRole) => Effect.Effect<ModelAssignment, ModelStoreError>
    readonly selection: (sessionId: string) => Effect.Effect<ModelAssignment, ModelStoreError>
    readonly contextBudget: (
      input: ModelContextBudgetInput
    ) => Effect.Effect<ModelContextBudget, ModelStoreError>
  }
>()("@arden-hq/server/persistence/models/ModelStore") {}
