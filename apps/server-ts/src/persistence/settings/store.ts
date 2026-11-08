import { storeErrorFields } from "../errors.js"
import type {
  IntelligenceSettings,
  IntelligenceSettingsPatch,
  LimitSettings,
  LimitSettingsPatch
} from "@arden-hq/protocol/settings"
import { Context, Effect, Schema, type Stream } from "effect"
import type { PlanLimitNotice } from "../../models/plan-limits.js"

export class IntelligenceSettingsStoreError extends Schema.TaggedError<IntelligenceSettingsStoreError>()(
  "IntelligenceSettingsStoreError",
  {
    ...storeErrorFields({
      operations: ["settings", "update_settings"],
      reasons: ["invalid", "storage"]
    })
  }
) {}

export class IntelligenceSettingsStore extends Context.Service<
  IntelligenceSettingsStore,
  {
    readonly settings: () => Effect.Effect<IntelligenceSettings, IntelligenceSettingsStoreError>
    readonly updateSettings: (
      patch: IntelligenceSettingsPatch
    ) => Effect.Effect<IntelligenceSettings, IntelligenceSettingsStoreError>
  }
>()("@arden-hq/server/persistence/settings/IntelligenceSettingsStore") {}

export class LimitSettingsStoreError extends Schema.TaggedError<LimitSettingsStoreError>()(
  "LimitSettingsStoreError",
  {
    ...storeErrorFields({
      operations: ["settings", "update_settings"],
      reasons: ["invalid", "storage"]
    })
  }
) {}

export class LimitSettingsStore extends Context.Service<
  LimitSettingsStore,
  {
    readonly settings: () => Effect.Effect<LimitSettings, LimitSettingsStoreError>
    readonly updateSettings: (
      patch: LimitSettingsPatch
    ) => Effect.Effect<LimitSettings, LimitSettingsStoreError>
    readonly changes: Stream.Stream<LimitSettings>
    readonly recheckPausedRuns: () => Effect.Effect<void, LimitSettingsStoreError>
    readonly recordNotice: (
      notice: PlanLimitNotice | undefined
    ) => Effect.Effect<void, LimitSettingsStoreError>
  }
>()("@arden-hq/server/persistence/settings/LimitSettingsStore") {}

export const EmbeddingSettingsSchema = Schema.Struct({
  modelId: Schema.NullOr(Schema.NonEmptyString),
  keepIndex: Schema.Boolean,
  paused: Schema.Boolean
})

export type EmbeddingSettings = typeof EmbeddingSettingsSchema.Type

export const EmbeddingSettingsPatchSchema = Schema.Struct({
  modelId: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  keepIndex: Schema.optionalKey(Schema.Boolean),
  paused: Schema.optionalKey(Schema.Boolean)
})

export class EmbeddingSettingsStoreError extends Schema.TaggedError<EmbeddingSettingsStoreError>()(
  "EmbeddingSettingsStoreError",
  {
    ...storeErrorFields({
      operations: ["settings", "update_settings"],
      reasons: ["invalid", "storage"]
    })
  }
) {}

export class EmbeddingSettingsStore extends Context.Service<
  EmbeddingSettingsStore,
  {
    readonly settings: () => Effect.Effect<EmbeddingSettings, EmbeddingSettingsStoreError>
    readonly updateSettings: (
      patch: typeof EmbeddingSettingsPatchSchema.Type
    ) => Effect.Effect<EmbeddingSettings, EmbeddingSettingsStoreError>
  }
>()("@arden-hq/server/persistence/settings/EmbeddingSettingsStore") {}
