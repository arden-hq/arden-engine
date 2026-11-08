import { storeErrorFields } from "../errors.js"
import { Context, Effect, Schema } from "effect"

export type WikiMaintenanceStoreOperation = "initialize" | "read" | "compare_and_set"

export interface WikiMaintenanceCompareAndSetInput {
  readonly expected: string | null
  readonly next: string
}

export class WikiMaintenanceStoreError extends Schema.TaggedError<WikiMaintenanceStoreError>()(
  "WikiMaintenanceStoreError",
  {
    ...storeErrorFields({
      operations: ["initialize", "read", "compare_and_set"],
      reasons: ["invalid", "conflict", "corrupt", "storage"]
    })
  }
) {}

export class WikiMaintenanceStore extends Context.Service<
  WikiMaintenanceStore,
  {
    readonly initialize: (
      processedHead: string | null
    ) => Effect.Effect<string | null, WikiMaintenanceStoreError>
    readonly processedHead: () => Effect.Effect<string | null, WikiMaintenanceStoreError>
    readonly compareAndSet: (
      input: WikiMaintenanceCompareAndSetInput
    ) => Effect.Effect<string | null, WikiMaintenanceStoreError>
  }
>()("@arden-hq/server/persistence/wiki-maintenance/WikiMaintenanceStore") {}
