import type { ChatMessage, ToolCallRequest, ToolResult } from "@arden-hq/loop"
import type { Schema } from "effect"

import type { AgentMode } from "../../sessions/agent-mode.js"
import type { CallParent } from "../../persistence/tools/tool-roles.js"

export const APPROVAL_CONTINUATION = { caller: "caller" } as const

export interface CodeModeCallRequest {
  readonly approvalContinuation?: typeof APPROVAL_CONTINUATION.caller
  readonly beforeExecute?: ToolCallRequest["beforeExecute"]
  readonly onResult?: (result: ToolResult) => void
  readonly onSettled?: (facts: NestedCallFacts) => void
  readonly parent: CallParent
  readonly toolCallId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly detached: boolean
  readonly messages: ReadonlyArray<ChatMessage>
}

export interface NestedCallFacts {
  readonly source_refs?: Schema.Json
  readonly change_evidence?: Schema.Json
}

export type ScriptFields = Readonly<Record<string, Schema.Json>>

export interface CodeModeHost {
  readonly call: (request: CodeModeCallRequest) => Promise<Schema.Json>
  readonly changesState: (name: string) => boolean
  readonly describe: (name: string) => Schema.Json | undefined
  readonly scriptFields: (toolCallId: string, fields: () => ScriptFields) => void
  readonly concurrencyGroup?: (name: string) => string | null
}

export type ScriptAgentMode = AgentMode

export interface ScriptAgentRequest {
  readonly beforeExecute?: ToolCallRequest["beforeExecute"]
  readonly parentToolCallId: string
  readonly index: number
  readonly occurrence: number
  readonly logicalKey: string
  readonly specificationHash: string
  readonly prompt: string
  readonly mode: ScriptAgentMode
  readonly model?: string
  readonly reasoningEffort?: string
  readonly label?: string
  readonly key?: string
  readonly phase?: string
  readonly schema?: Readonly<Record<string, Schema.Json>>
  readonly signal: AbortSignal
}

type ScriptAgentChildReference = {
  readonly sessionRef: string
  readonly runId: string
}

type ScriptAgentChildAttemptBase = {
  readonly attempt: number
  readonly schemaAttempt: number
  readonly restartAttempt: number
  readonly parentRunId: string
  readonly parentToolCallId: string
}

export const CHILD_ATTEMPT = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  interrupted: "interrupted",
  cancelled: "cancelled",
  invalidOutput: "invalid_output",
  launchFailed: "launch_failed"
} as const

export type ScriptAgentChildAttemptEvent =
  | (ScriptAgentChildAttemptBase & {
      readonly status: typeof CHILD_ATTEMPT.queued
    })
  | (ScriptAgentChildAttemptBase & {
      readonly status: typeof CHILD_ATTEMPT.running | typeof CHILD_ATTEMPT.succeeded
      readonly child: ScriptAgentChildReference
    })
  | (ScriptAgentChildAttemptBase & {
      readonly status:
        | typeof CHILD_ATTEMPT.failed
        | typeof CHILD_ATTEMPT.interrupted
        | typeof CHILD_ATTEMPT.cancelled
        | typeof CHILD_ATTEMPT.invalidOutput
      readonly child: ScriptAgentChildReference
      readonly error: string
      readonly retryable: boolean
    })
  | (ScriptAgentChildAttemptBase & {
      readonly status: typeof CHILD_ATTEMPT.launchFailed
      readonly error: string
      readonly retryable: boolean
    })

export interface ScriptAgentObserver {
  readonly recordReuse: (toolCallId: string) => void
  readonly reserveLaunch: () => number
  readonly recordChildAttempt: (event: ScriptAgentChildAttemptEvent) => Promise<void>
}

export interface ScriptAgentExecutionProfile {
  readonly hash: string
  readonly modes: Readonly<
    Record<
      ScriptAgentMode,
      {
        readonly changesState: boolean
      }
    >
  >
}

interface ScriptAgentLaunch extends ScriptAgentRequest {
  readonly launch: number
}

export interface ScriptHost {
  readonly executionProfile: ScriptAgentExecutionProfile
  readonly agent: (
    request: ScriptAgentLaunch,
    observer: ScriptAgentObserver
  ) => Promise<Schema.Json>
  readonly tool: CodeModeHost["call"]
  readonly changesState: CodeModeHost["changesState"]
  readonly describe?: CodeModeHost["describe"]
  readonly concurrencyGroup?: CodeModeHost["concurrencyGroup"]
}

export class ScriptShutdown extends Error {
  constructor() {
    super("Arden is stopping")
  }
}
