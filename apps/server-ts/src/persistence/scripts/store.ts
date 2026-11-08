import type {
  SettledWorkflowStatus,
  WorkflowError,
  WorkflowSourceRef
} from "@arden-hq/protocol/workflows"
import { Context, Schema, type Effect } from "effect"

type ScriptStatus = "running" | SettledWorkflowStatus

type SettledScriptStatus = SettledWorkflowStatus

export interface ScriptRecord {
  readonly ref: string
  readonly originSessionRef: string
  readonly originSessionId: string
  readonly originRunId: string
  readonly originToolCallId: string
  readonly profileHash: string
  readonly status: ScriptStatus
  readonly version: number
  readonly attempt: number
  readonly autoRetries: number
  readonly error: WorkflowError | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly endedAt: string | null
}

export interface ScriptSettlement {
  readonly status: SettledScriptStatus
  readonly value: Schema.Json
  readonly error: WorkflowError | null
  readonly sourceRefs: ReadonlyArray<WorkflowSourceRef>
}

export class ScriptStoreError extends Schema.TaggedError<ScriptStoreError>()("ScriptStoreError", {
  reason: Schema.Literals(["not_found", "conflict", "unsafe_retry", "corrupt", "storage"] as const),
  message: Schema.String,
  ref: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class ScriptStore extends Context.Service<
  ScriptStore,
  {
    readonly create: (input: {
      readonly ref: string
      readonly originSessionRef: string
      readonly originRunId: string
      readonly originToolCallId: string
      readonly profileHash: string
    }) => Effect.Effect<ScriptRecord, ScriptStoreError>
    readonly progress: (input: {
      readonly ref: string
      readonly attempt: number
      readonly data: Readonly<Record<string, Schema.Json>>
    }) => Effect.Effect<void, ScriptStoreError>
    readonly get: (ref: string) => Effect.Effect<ScriptRecord, ScriptStoreError>
    readonly running: () => Effect.Effect<ReadonlyArray<ScriptRecord>, ScriptStoreError>
    readonly runningOfFencedRuns: () => Effect.Effect<ReadonlyArray<ScriptRecord>, ScriptStoreError>
    readonly nextAttempt: (input: {
      readonly ref: string
      readonly attempt: number
      readonly auto: boolean
    }) => Effect.Effect<ScriptRecord, ScriptStoreError>
    readonly retry: (input: {
      readonly ref: string
      readonly expectedVersion: number
    }) => Effect.Effect<ScriptRecord, ScriptStoreError>
    readonly settle: (input: {
      readonly ref: string
      readonly attempt: number
      readonly settlement: ScriptSettlement
    }) => Effect.Effect<ScriptRecord | undefined, ScriptStoreError>
    readonly cancel: (ref: string) => Effect.Effect<ScriptRecord, ScriptStoreError>
  }
>()("@arden-hq/server/persistence/scripts/ScriptStore") {}
