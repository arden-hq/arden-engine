import { STORE_REASON } from "../errors.js"
import type { PersistedChildAgentMetadata } from "@arden-hq/protocol/chat"
import type { ToolResult } from "@arden-hq/loop"
import {
  ChatAgentSpawnError,
  ChatWriteError,
  ChatWriteConflictError,
  type ChatWriteSpawnAgentInput,
  type ChatWriteSpawnAgentFailure
} from "../chat/store.js"
import { ToolExecutionStoreError } from "../tools/store.js"
import { type AgentMode } from "../../sessions/agent-mode.js"
import { writeError } from "./chat-write-errors.js"
import { type RunRow } from "./chat-run.js"
import { mutationReceiptHost, type MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { chatHref } from "../../sessions/chat-href.js"

export interface SpawnParentRow extends RunRow {
  readonly public_ref: string
  readonly name: string
  readonly space_id: string | null
  readonly origin_automation_id: string | null
  readonly archived_at: string | null
  readonly session_type: string
  readonly session_metadata: string | null
}

export interface SpawnLineageRow {
  readonly root_session_id: string
  readonly agent_depth: number
}

export interface ExistingChildRow {
  readonly output_schema: string | null
  readonly space_id: string | null
  readonly session_id: string
  readonly public_ref: string
  readonly name: string | null
  readonly metadata: string | null
  readonly chat_model: string | null
  readonly session_type: string
  readonly run_id: string
  readonly status: string
  readonly assistant_message_id: string
  readonly model_id: string | null
  readonly reasoning_effort: string | null
  readonly last_seq: number | null
  readonly head_sequence: number | null
  readonly automation_task_id: string | null
  readonly automation_name: string | null
  readonly automation_context_mode: string | null
  readonly turn_id: string
}

export const spawnError = (
  reason: "invalid_parent" | "max_depth" | "working_directory",
  message: string,
  input?: Pick<ChatWriteSpawnAgentInput["parent"], "runId" | "toolCallId">,
  cause?: unknown
): ChatAgentSpawnError =>
  new ChatAgentSpawnError({
    reason,
    retryable: false,
    message,
    ...(input === undefined ? {} : { runId: input.runId, toolCallId: input.toolCallId }),
    ...(cause === undefined ? {} : { cause })
  })

export type SpawnFailureMapper = (cause: unknown) => ChatWriteSpawnAgentFailure

export const mapSpawnFailure =
  (input: Pick<ChatWriteSpawnAgentInput["parent"], "runId" | "toolCallId">): SpawnFailureMapper =>
  (cause: unknown): ChatWriteSpawnAgentFailure => {
    if (
      cause instanceof ChatAgentSpawnError ||
      cause instanceof ChatWriteError ||
      cause instanceof ChatWriteConflictError
    )
      return cause
    if (cause instanceof ToolExecutionStoreError) {
      return cause.reason === STORE_REASON.storage
        ? writeError("spawn_agent", "storage", "Could not settle the spawn tool", {
            runId: input.runId,
            cause
          })
        : spawnError("invalid_parent", cause.message, input, cause)
    }
    return writeError("spawn_agent", "storage", "Could not spawn agent", {
      runId: input.runId,
      cause
    })
  }

export const agentSpawnResult = (
  child: {
    readonly sessionId: string
    readonly sessionRef: string
    readonly name: string | null
  },
  runId: string,
  mode: AgentMode,
  spawn: MutationOperationIdentity
): ToolResult => {
  const { sessionId, sessionRef } = child
  const childAgent = {
    session_id: sessionId,
    session_ref: sessionRef,
    run_id: runId,
    status: "running",
    mode
  } satisfies PersistedChildAgentMetadata

  return {
    content: [
      `Started independent ${mode} agent [${sessionRef}](${chatHref({ publicRef: sessionRef })}).`,
      "Continue independent work. Use agent_message with this reference to coordinate or nudge. Its final result is delivered here automatically; do not claim its findings before that notification arrives."
    ].join(" "),
    preview: "Agent started",
    data: {
      child_agent: childAgent
    },
    host: mutationReceiptHost({
      identity: spawn,
      outcome: "applied",
      resource: {
        kind: "target",
        resourceRef: `session:${sessionId}`,
        domain: "session",
        title: child.name?.trim() || sessionRef,
        href: chatHref({ publicRef: sessionRef })
      }
    })
  }
}
