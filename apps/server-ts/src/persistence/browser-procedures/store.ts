import type { JobDriver } from "@arden-hq/jobs"
import { Context, Effect, Schema } from "effect"
import type { BrowserProcedureList } from "@arden-hq/protocol/browser-procedures"
import type {
  ProcedureEvidence,
  ProcedureJob,
  ProcedurePolicy,
  ProcedureSpec,
  StoredProcedure
} from "./model.js"

export class BrowserProcedureStoreError extends Schema.TaggedError<BrowserProcedureStoreError>()(
  "BrowserProcedureStoreError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}
export class BrowserProcedureStore extends Context.Service<
  BrowserProcedureStore,
  {
    readonly list: () => Effect.Effect<BrowserProcedureList, BrowserProcedureStoreError>
    readonly get: (
      id: string
    ) => Effect.Effect<StoredProcedure | undefined, BrowserProcedureStoreError>
    readonly eligible: (
      origin: string,
      profile: string
    ) => Effect.Effect<ReadonlyArray<StoredProcedure>, BrowserProcedureStoreError>
    readonly enable: (
      enabled: boolean,
      id?: string
    ) => Effect.Effect<void, BrowserProcedureStoreError>
    readonly enqueue: () => Effect.Effect<void, BrowserProcedureStoreError>
    readonly jobs: JobDriver<ProcedureJob, void>
    readonly tabOwner: (
      tabRef: string
    ) => Effect.Effect<
      | { readonly runId: string; readonly parentToolCallId: string; readonly toolCallId: string }
      | undefined,
      BrowserProcedureStoreError
    >
    readonly scope: (
      runId: string,
      callId: string
    ) => Effect.Effect<
      | {
          readonly origin: string
          readonly profile: string
          readonly tab: string
          readonly readOnly: boolean
          readonly calls: number
          readonly replay: boolean
          readonly rejected: boolean
          readonly policy: ProcedurePolicy
        }
      | undefined,
      BrowserProcedureStoreError
    >
    readonly readOnly: (
      runId: string,
      callId: string
    ) => Effect.Effect<void, BrowserProcedureStoreError>
    readonly acted: (
      runId: string,
      toolCallId: string
    ) => Effect.Effect<boolean, BrowserProcedureStoreError>
    readonly mayHaveChanged: (
      runId: string,
      toolCallId: string
    ) => Effect.Effect<boolean, BrowserProcedureStoreError>
    readonly rejection: (
      runId: string,
      toolCallId: string
    ) => Effect.Effect<{ readonly feedback: string | null } | undefined, BrowserProcedureStoreError>
    readonly evidence: (
      runId: string
    ) => Effect.Effect<ProcedureEvidence | undefined, BrowserProcedureStoreError>
    readonly publish: (input: {
      readonly id?: string
      readonly origin: string
      readonly profile: string
      readonly spec: ProcedureSpec
      readonly evidence: ReadonlyArray<ProcedureEvidence>
    }) => Effect.Effect<string, BrowserProcedureStoreError>
    readonly invocation: (
      runId: string,
      parentToolCallId: string
    ) => Effect.Effect<
      | {
          readonly procedure: StoredProcedure
          readonly input: Readonly<Record<string, Schema.Json>>
          readonly toolCallId: string
          readonly tab: string
        }
      | undefined,
      BrowserProcedureStoreError
    >
    readonly begin: (input: {
      readonly runId: string
      readonly toolCallId: string
      readonly procedure: StoredProcedure
      readonly parentToolCallId: string
      readonly policy: ProcedurePolicy
      readonly input: Readonly<Record<string, Schema.Json>>
      readonly tab: string
    }) => Effect.Effect<void, BrowserProcedureStoreError>
    readonly settle: (
      runId: string,
      toolCallId: string,
      status: "succeeded" | "failed" | "uncertain" | "not_applicable"
    ) => Effect.Effect<void, BrowserProcedureStoreError>
    readonly reconcile: () => Effect.Effect<void, BrowserProcedureStoreError>
  }
>()("@arden-hq/server/persistence/BrowserProcedureStore") {}
