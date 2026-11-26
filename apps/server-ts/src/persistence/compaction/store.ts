import { storeErrorFields } from "../errors.js"
import { Context, Effect, Schema } from "effect"
import type { JsonObject } from "../json.js"
import type { StoredMessageEnvelope, TranscriptMessageDraft } from "../transcript/model.js"

export type ContextCompactionOperation = "measure" | "snapshot" | "commit"

export const CONTEXT_COMPACTION_PURPOSE = { idle: "idle" } as const

export interface ContextCompactionSnapshotInput {
  readonly purpose?: typeof CONTEXT_COMPACTION_PURPOSE.idle
  readonly sessionId: string
  readonly runId?: string
}

export interface ContextCompactionMeasure {
  readonly sessionId: string
  readonly runId: string | null
  readonly modelId: string | null
  readonly messageCount: number
  readonly metadata: JsonObject
}

export interface ContextCompactionSnapshot {
  readonly sessionId: string
  readonly sessionRef: string
  readonly sourceSessionRef: string | undefined
  readonly runId: string | null
  readonly modelId: string | null
  readonly reasoningEffort: string | null
  readonly messages: ReadonlyArray<StoredMessageEnvelope>
  readonly ownerWords: ReadonlySet<string>
  readonly contextVersion: string
  readonly metadata: JsonObject
  readonly contextGeneration: number
}

export interface ContextCompactionCommitInput {
  readonly purpose?: typeof CONTEXT_COMPACTION_PURPOSE.idle
  readonly sessionId: string
  readonly runId?: string
  readonly expectedContextGeneration: number
  readonly expectedContextVersion: string
  readonly handoff: TranscriptMessageDraft
}

export interface ContextCompactionCommitResult {
  readonly sessionId: string
  readonly contextGeneration: number
  readonly messagesBefore: number
  readonly messagesAfter: number
  readonly messages: ReadonlyArray<StoredMessageEnvelope>
}

export class ContextCompactionStoreError extends Schema.TaggedError<ContextCompactionStoreError>()(
  "ContextCompactionStoreError",
  {
    ...storeErrorFields({
      operations: ["measure", "snapshot", "commit"],
      reasons: ["invalid", "not_found", "conflict", "corrupt", "storage"]
    }),
    sessionId: Schema.optionalKey(Schema.NonEmptyString),
    runId: Schema.optionalKey(Schema.NonEmptyString)
  }
) {}

export class ContextCompactionStore extends Context.Service<
  ContextCompactionStore,
  {
    readonly measure: (
      input: ContextCompactionSnapshotInput
    ) => Effect.Effect<ContextCompactionMeasure, ContextCompactionStoreError>
    readonly snapshot: (
      input: ContextCompactionSnapshotInput
    ) => Effect.Effect<ContextCompactionSnapshot, ContextCompactionStoreError>
    readonly commit: (
      input: ContextCompactionCommitInput
    ) => Effect.Effect<ContextCompactionCommitResult, ContextCompactionStoreError>
  }
>()("@arden-hq/server/persistence/compaction/ContextCompactionStore") {}
