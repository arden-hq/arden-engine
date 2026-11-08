import type {
  ScriptAgentAttempt,
  ScriptExecution,
  WorkflowEffectDisposition,
  WorkflowSourceRef
} from "@arden-hq/protocol/workflows"
import { Context, Schema, type Effect } from "effect"

export interface ScriptOrigin {
  readonly originRunId: string
  readonly originToolCallId: string
}

type UnsafeEffect = "applied" | "unknown"

export type AgentDecision =
  | {
      readonly kind: "reuse"
      readonly toolCallId: string
      readonly value: Schema.Json
      readonly sourceRefs: ReadonlyArray<WorkflowSourceRef>
    }
  | { readonly kind: "launch"; readonly launch: number }
  | { readonly kind: "refuse"; readonly toolCallId: string; readonly effect: UnsafeEffect }

export type NestedResolution =
  | { readonly kind: "run"; readonly toolCallId: string }
  | { readonly kind: "refuse"; readonly toolCallId: string; readonly effect: UnsafeEffect }

export type RetryVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "refuse"; readonly effect: UnsafeEffect }

export interface ChildObservation {
  readonly effectDisposition: WorkflowEffectDisposition
  readonly sourceRefs: ReadonlyArray<WorkflowSourceRef>
}

export interface ScriptAgentView {
  readonly key: string
  readonly attempts: ReadonlyArray<ScriptAgentAttempt>
  readonly label: string
  readonly mode: "research" | "code" | null
  readonly status: "running" | "completed" | "failed"
  readonly sessionRef: string
}

export interface ScriptDefinition {
  readonly code: string
  readonly args: Readonly<Record<string, Schema.Json>>
  readonly maxAgents: number
}

export class ScriptJournalError extends Schema.TaggedError<ScriptJournalError>()(
  "ScriptJournalError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class ScriptJournal extends Context.Service<
  ScriptJournal,
  {
    readonly agentDecision: (
      input: ScriptOrigin & {
        readonly key: string
        readonly schema: Readonly<Record<string, Schema.Json>> | undefined
      }
    ) => Effect.Effect<AgentDecision, ScriptJournalError>
    readonly nestedCall: (
      input: ScriptOrigin & { readonly toolCallId: string; readonly attempt: number }
    ) => Effect.Effect<NestedResolution, ScriptJournalError>
    readonly retryVerdict: (origin: ScriptOrigin) => Effect.Effect<RetryVerdict, ScriptJournalError>
    readonly awaitingDecision: (origin: ScriptOrigin) => Effect.Effect<boolean, ScriptJournalError>
    readonly observeChild: (runId: string) => Effect.Effect<ChildObservation, ScriptJournalError>
    readonly activeChildRuns: (
      origin: ScriptOrigin
    ) => Effect.Effect<ReadonlyArray<string>, ScriptJournalError>
    readonly agents: (
      origin: ScriptOrigin
    ) => Effect.Effect<ReadonlyArray<ScriptAgentView>, ScriptJournalError>
    readonly executions: (
      origin: ScriptOrigin
    ) => Effect.Effect<ReadonlyArray<ScriptExecution>, ScriptJournalError>
    readonly definition: (
      origin: ScriptOrigin
    ) => Effect.Effect<ScriptDefinition | undefined, ScriptJournalError>
  }
>()("@arden-hq/server/persistence/scripts/ScriptJournal") {}
