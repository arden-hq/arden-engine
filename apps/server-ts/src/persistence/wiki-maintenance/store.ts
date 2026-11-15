import { storeErrorFields } from "../errors.js"
import { Context, Effect, Schema } from "effect"

export type WikiMaintenanceStoreOperation = "initialize" | "read" | "compare_and_set" | "refuse"

export interface WikiMaintenanceCompareAndSetInput {
  readonly expected: string | null
  readonly next: string
}

/** A range Tidy was blocked on once: from where it stands to the head it reviewed. */
export interface WikiMaintenanceRefusal {
  readonly from: string | null
  readonly to: string
}

export class WikiMaintenanceStoreError extends Schema.TaggedError<WikiMaintenanceStoreError>()(
  "WikiMaintenanceStoreError",
  {
    ...storeErrorFields({
      operations: ["initialize", "read", "compare_and_set", "refuse"],
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
    readonly refusal: () => Effect.Effect<
      WikiMaintenanceRefusal | undefined,
      WikiMaintenanceStoreError
    >
    /** Marks a range blocked once; moving Tidy's place clears the mark. */
    readonly refuse: (
      refusal: WikiMaintenanceRefusal
    ) => Effect.Effect<void, WikiMaintenanceStoreError>
  }
>()("@arden-hq/server/persistence/wiki-maintenance/WikiMaintenanceStore") {}
