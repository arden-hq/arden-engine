import { storeErrorFields } from "../errors.js"
import type { ModelCallKind } from "@arden-hq/protocol/runs"
import type { StoredSessionRun, StoredUsageReport } from "./report.js"
import { Context, Effect, Schema } from "effect"
import type { StoredRunUsage } from "../runs/stored-result.js"

export class UsageStoreError extends Schema.TaggedError<UsageStoreError>()("UsageStoreError", {
  ...storeErrorFields({
    operations: ["report", "backfill", "record", "session"],
    reasons: ["invalid", "storage"]
  })
}) {}

type UsageOwner =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "space"; readonly spaceId: string }
  | { readonly type: "none" }

export interface ModelCallUsage {
  readonly kind: Exclude<ModelCallKind, "chat">
  readonly owner: UsageOwner
}

export type UsageTokens = StoredRunUsage

export interface StoredSessionUsage {
  readonly session_id: string
  readonly runs: ReadonlyArray<StoredSessionRun>
}

export class UsageStore extends Context.Service<
  UsageStore,
  {
    readonly report: (options: {
      readonly days: number
      readonly throughDay?: string
    }) => Effect.Effect<StoredUsageReport, UsageStoreError>
    readonly sessionUsage: (options: {
      readonly sessionId: string
      readonly limit: number
    }) => Effect.Effect<StoredSessionUsage, UsageStoreError>
    readonly recordModelCall: (
      input: ModelCallUsage & { readonly modelId: string; readonly usage: UsageTokens }
    ) => Effect.Effect<void, UsageStoreError>
  }
>()("@arden-hq/server/persistence/usage/UsageStore") {}
