import type { Schema } from "effect"

export const SERVER_EVENT_TYPE = {
  reasoningMessageStart: "REASONING_MESSAGE_START",
  reasoningMessageContent: "REASONING_MESSAGE_CONTENT",
  reasoningMessageEnd: "REASONING_MESSAGE_END",
  streamKeepalive: "stream_keepalive",
  streamSnapshot: "stream_snapshot",
  streamLive: "stream_live",
  streamOverflow: "stream_overflow",
  approvalNeeded: "approval_needed",
  approvalResolved: "approval_resolved",
  connectionNeeded: "connection_needed",
  connectionResolved: "connection_resolved",
  textMessageStart: "TEXT_MESSAGE_START",
  textMessageContent: "TEXT_MESSAGE_CONTENT",
  textMessageEnd: "TEXT_MESSAGE_END",
  textMessagePhase: "TEXT_MESSAGE_PHASE",
  messageIngested: "message_ingested",
  transcriptChanged: "transcript_changed",
  compactionStarted: "compaction_started",
  compactionFinished: "compaction_finished",
  focusUpdated: "focus_updated",
  focusCleared: "focus_cleared",
  todoUpdated: "todo_updated",
  streamReset: "stream_reset",
  automationProgress: "automation_progress",
  automationFinished: "automation_finished",
  recordTold: "record_told",
  sessionCreated: "session_created",
  sessionActivity: "session_activity",
  chatInputCommitted: "chat_input_committed",
  sessionBlockingWork: "session_blocking_work",
  mcpServerChanged: "mcp_server_changed",
  entityChanged: "entity_changed",
  navigationRequested: "navigation_requested",
  questionChanged: "question_changed",
  taskVisibilityChanged: "task_visibility_changed",
  workChanged: "work_changed",
  taskProposalChanged: "task_proposal_changed",
  focusChoiceChanged: "focus_choice_changed",
  taskWorkChanged: "task_work_changed",
  runStarted: "RUN_STARTED",
  sessionUpdated: "session_updated",
  runFinished: "RUN_FINISHED",
  runCancelled: "run_cancelled",
  runError: "RUN_ERROR",
  tokenUsage: "token_usage",
  runActivity: "run_activity",
  thinking: "thinking",
  inputTaken: "input_taken",
  streamRetry: "stream_retry",
  modelResponseReset: "model_response_reset",
  finalTextSuperseded: "final_text_superseded",
  toolCallStart: "TOOL_CALL_START",
  toolCallArgs: "TOOL_CALL_ARGS",
  toolCallOutputDelta: "TOOL_CALL_OUTPUT_DELTA",
  toolCallProgress: "TOOL_CALL_PROGRESS",
  toolCallWaiting: "TOOL_CALL_WAITING",
  toolCallEnd: "TOOL_CALL_END",
  toolCallResult: "TOOL_CALL_RESULT"
} as const

export type ServerEventType = (typeof SERVER_EVENT_TYPE)[keyof typeof SERVER_EVENT_TYPE]

const isSchemaNode = (value: unknown): value is Readonly<Record<string, unknown>> =>
  (typeof value === "object" || typeof value === "function") && value !== null

const literalOf = (value: unknown): string | undefined =>
  isSchemaNode(value) && typeof value.literal === "string" ? value.literal : undefined

export const eventTypeLiterals = (members: ReadonlyArray<Schema.Top>): ReadonlySet<string> => {
  const found = new Set<string>()
  const walk = (value: unknown): void => {
    if (!isSchemaNode(value)) return
    if (Array.isArray(value.members)) {
      for (const member of value.members) walk(member)
      return
    }
    if (isSchemaNode(value.fields)) {
      const literal = literalOf(value.fields.type)
      if (literal !== undefined) found.add(literal)
      return
    }
    if ("schema" in value) walk(value.schema)
  }
  for (const member of members) walk(member)
  return found
}
