import { storeErrorFields } from "../errors.js"
import type { StorageSettings, StorageRetention } from "@arden-hq/protocol/storage"
import { Context, Effect, Schema } from "effect"

export type StoragePolicyStoreOperation = "settings" | "update_settings"

export class StoragePolicyStoreError extends Schema.TaggedError<StoragePolicyStoreError>()(
  "StoragePolicyStoreError",
  {
    ...storeErrorFields({
      operations: ["settings", "update_settings"],
      reasons: ["invalid", "not_found", "storage"]
    })
  }
) {}

export class StoragePolicyStore extends Context.Service<
  StoragePolicyStore,
  {
    readonly retention: () => Effect.Effect<StorageRetention, StoragePolicyStoreError>
    readonly updateRetention: (
      settings: StorageRetention
    ) => Effect.Effect<StorageRetention, StoragePolicyStoreError>
    readonly settings: () => Effect.Effect<StorageSettings, StoragePolicyStoreError>
    readonly updateSettings: (
      settings: StorageSettings
    ) => Effect.Effect<StorageSettings, StoragePolicyStoreError>
  }
>()("@arden-hq/server/persistence/storage/StoragePolicyStore") {}
