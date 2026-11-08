import { storeErrorFields } from "../errors.js"
import type { OfferHistory, OfferHolders, PermissionChange } from "./offer.js"
import type { RuleList } from "./rules.js"
import { Context, Effect, Schema } from "effect"

export type PermissionStoreOperation = "run_grants" | "offers"

export class PermissionStoreError extends Schema.TaggedError<PermissionStoreError>()(
  "PermissionStoreError",
  {
    ...storeErrorFields({
      operations: ["run_grants", "offers"],
      reasons: ["invalid", "not_found", "storage"]
    })
  }
) {}

export class PermissionStore extends Context.Service<
  PermissionStore,
  {
    readonly offerHolders: (
      runId: string
    ) => Effect.Effect<OfferHolders | null, PermissionStoreError>
    readonly allowSaves: (
      change: PermissionChange,
      serverName: string | null,
      list: RuleList
    ) => Effect.Effect<boolean, PermissionStoreError>
    readonly offerHistory: (
      runId: string,
      change: PermissionChange
    ) => Effect.Effect<OfferHistory, PermissionStoreError>
  }
>()("@arden-hq/server/persistence/permissions/PermissionStore") {}
