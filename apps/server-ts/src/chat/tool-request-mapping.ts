import { AGENT_MODE } from "@arden-hq/protocol/chat"
import { ToolExecutionError } from "@arden-hq/loop"
import { toolFailure, toolRefusal } from "../tools/tool-failure.js"
import {
  CHAT_AGENT_SPAWN_REASON,
  ChatAgentSpawnError,
  ChatWriteConflictError,
  ChatWriteError,
  type ChatWriteSpawnAgentInput
} from "../persistence/chat/store.js"
import { type ToolExecutionIdentity } from "../persistence/tools/store.js"
import type { ChatRunnerSpawnAgentRequest, ChatRunnerToolRequest } from "./runner-contract.js"

export const toolIdentity = (
  run: { readonly runId: string; readonly sessionId: string },
  request: ChatRunnerToolRequest
): ToolExecutionIdentity => ({
  runId: run.runId,
  sessionId: run.sessionId,
  toolCallId: request.toolCallId,
  toolName: request.name,
  arguments: request.args,
  changesState: request.changesState,
  ...(request.effect === undefined ? {} : { effect: request.effect }),
  ...(request.source === undefined ? {} : { source: request.source })
})

export const spawnInput = (
  run: { readonly runId: string; readonly sessionId: string },
  request: ChatRunnerSpawnAgentRequest
): ChatWriteSpawnAgentInput => {
  const parent: ToolExecutionIdentity = {
    runId: run.runId,
    sessionId: run.sessionId,
    toolCallId: request.toolCallId,
    toolName: "spawn_agent",
    arguments: request.arguments,
    changesState: true,
    effect: "arden_db"
  }
  const base = {
    parent,
    task: request.task,
    ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
    ...(request.taskItemId === undefined ? {} : { taskItemId: request.taskItemId }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    ...(request.defaultModel === undefined ? {} : { defaultModel: request.defaultModel }),
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.forkHistory === undefined ? {} : { forkHistory: request.forkHistory })
  }
  return request.mode === AGENT_MODE.code
    ? {
        ...base,
        mode: "code",
        workspace: request.workspace,
        ...(request.requestedWorkingDirectory === undefined
          ? {}
          : { requestedWorkingDirectory: request.requestedWorkingDirectory })
      }
    : { ...base, mode: request.mode }
}

export const spawnFailure = (cause: unknown): ToolExecutionError => {
  if (cause instanceof ChatAgentSpawnError) {
    return new ToolExecutionError(cause.message, {
      preview: spawnErrorPreview(cause.reason),
      retryable: cause.retryable
    })
  }
  if (cause instanceof ChatWriteError) return toolFailure(cause, "Agent was not started")
  if (cause instanceof ChatWriteConflictError)
    return toolRefusal(cause.message, "Agent was not started")
  return new ToolExecutionError("The agent Session could not be started", {
    preview: "Agent was not started",
    retryable: true
  })
}

const spawnErrorPreview = (reason: ChatAgentSpawnError["reason"]): string => {
  switch (reason) {
    case CHAT_AGENT_SPAWN_REASON.maxDepth:
      return "Agent depth limit reached"
    case CHAT_AGENT_SPAWN_REASON.invalidParent:
      return "Agent was not started"
    case CHAT_AGENT_SPAWN_REASON.workingDirectory:
      return "Working directory required"
  }
}
