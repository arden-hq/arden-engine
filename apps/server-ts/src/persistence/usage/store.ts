import { storeErrorFields } from "../errors.js"
import type {
  ModelCallKind,
  RunTerminalResult,
  SessionRunRecord,
  UsageReport
} from "@arden-hq/protocol/runs"
import { Context, Effect, Schema } from "effect"

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

export type UsageTokens = RunTerminalResult["usage"]

export interface StoredSessionUsage {
  readonly session_id: string
  readonly runs: ReadonlyArray<SessionRunRecord>
}

export class UsageStore extends Context.Service<
  UsageStore,
  {
    readonly report: (options: {
      readonly days: number
      readonly throughDay?: string
    }) => Effect.Effect<UsageReport, UsageStoreError>
    readonly sessionUsage: (options: {
      readonly sessionId: string
      readonly limit: number
    }) => Effect.Effect<StoredSessionUsage, UsageStoreError>
    readonly recordModelCall: (
      input: ModelCallUsage & { readonly modelId: string; readonly usage: UsageTokens }
    ) => Effect.Effect<void, UsageStoreError>
  }
>()("@arden-hq/server/persistence/usage/UsageStore") {}
