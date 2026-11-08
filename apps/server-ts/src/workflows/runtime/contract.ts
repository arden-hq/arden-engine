import type { ChatMessage, ToolCallRequest, ToolResult } from "@arden-hq/loop"
import type { Schema } from "effect"

import type { AgentMode } from "../../sessions/agent-mode.js"

export interface CodeModeCallRequest {
  readonly approvalContinuation?: "caller"
  readonly beforeExecute?: ToolCallRequest["beforeExecute"]
  readonly onResult?: (result: ToolResult) => void
  readonly onSettled?: (facts: NestedCallFacts) => void
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

export type ScriptAgentMode = Exclude<AgentMode, "work">

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

export type ScriptAgentChildAttemptEvent =
  | (ScriptAgentChildAttemptBase & {
      readonly status: "queued"
    })
  | (ScriptAgentChildAttemptBase & {
      readonly status: "running" | "succeeded"
      readonly child: ScriptAgentChildReference
    })
  | (ScriptAgentChildAttemptBase & {
      readonly status: "failed" | "interrupted" | "cancelled" | "invalid_output"
      readonly child: ScriptAgentChildReference
      readonly error: string
      readonly retryable: boolean
    })
  | (ScriptAgentChildAttemptBase & {
      readonly status: "launch_failed"
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
