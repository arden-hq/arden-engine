import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ChatEventStore } from "../events/store.js"
import type { EventDraft } from "../events/model.js"
import { SessionLifecycleEvents } from "../sessions/events.js"
import { StorageStartupError } from "../service.js"
import { executionBudgetExpired } from "./execution-budgets.js"
import { settleRun } from "./run-settle.js"
import { settleTerminalToolsInTransaction } from "./tool-terminal.js"
import { decodeJson } from "./json.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import { completedRunReply } from "./run-completion.js"
import { scriptOwnsRun } from "./run-owner.js"
import { loadActiveContext } from "./active-context.js"
import { markRunToolExecutionsUncertainInTransaction } from "./tool-uncertainty.js"
import {
  settleToolExecutionInTransaction,
  settleUnstartedToolWorkForTerminalInTransaction
} from "./tool-receipts.js"
import {
  appendEscalatedApprovalDraft,
  ensurePendingToolApprovalInTransaction
} from "./tool-approvals.js"
import { type PendingToolApprovalInput } from "./tool-approval-drafts.js"
import { agentSpawnResult } from "./chat-agent-spawn-rows.js"
import { JsonObjectSchema } from "../json.js"
import { readAgentSessionMetadata } from "../../sessions/agent-mode.js"
import { REPLAYABLE_CONTROL_TOOLS } from "../tools/tool-roles.js"
import {
  type ActiveChatRunRow,
  appendRecoveredMessagesInTransaction,
  continueFinishedRunInTransaction,
  loadRunStreamedMessages,
  textEnd,
  RECOVERED_SETTLEMENT,
  type QueuedMessage,
  type RecoveryCause,
  settledToolStatus,
  settlementOf,
  terminalEvent,
  runTerminal
} from "./recovery-finish.js"
import { activeRunStatusList, unfinishedRequestStatusList } from "./status-sets.js"
import { RESTART_APPROVAL_DETAIL, RESTART_INTERRUPTION } from "../restart-notice.js"
import { appendRunSettledInTransaction } from "./run-settled.js"
import { keyMessageJson } from "./chat-key-message.js"

interface PendingMessageRow {
  readonly client_id: string
  readonly message_id: string | null
  readonly message_json: string | null
}

interface SpawnedChildRow {
  readonly tool_call_id: string
  readonly arguments_json: string
  readonly child_session_id: string
  readonly public_ref: string
  readonly name: string | null
  readonly metadata: string | null
  readonly child_run_id: string
}

interface UnresolvedToolRow {
  readonly run_id: string
  readonly session_id: string
  readonly tool_call_id: string
  readonly tool_name: string
  readonly changes_state: number
  readonly status: "paused" | "uncertain"
}

export const serverRestart: RecoveryCause = {
  stopReason: "server_restart",
  interruption: RESTART_INTERRUPTION,
  errorCode: "run_interrupted",
  approvalDetail: RESTART_APPROVAL_DETAIL,
  ending: "process_restarted"
}

export const lostOwner: RecoveryCause = {
  stopReason: "abandoned",
  interruption: "The assistant run stopped without finishing.",
  errorCode: "run_interrupted",
  approvalDetail: "This tool is waiting for approval. Approve or reject it to continue.",
  ending: "run_ended"
}

const allowanceEnded: RecoveryCause = {
  stopReason: "allowance_ended",
  interruption: "The run stopped because its execution allowance ended.",
  errorCode: "runner_error",
  approvalDetail: "This tool is waiting for approval. Approve or reject it to continue.",
  ending: "run_ended"
}

export const recoveryError = (cause: unknown): StorageStartupError =>
  new StorageStartupError({
    operation: "recover",
    message: "Could not interrupt active Chat runs after restart",
    cause
  })

export const lastActiveAt = Effect.fn("SqlitePersistence.lastActiveAt")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  fallback: string
) {
  const rows = yield* sql<{ readonly updated_at: string }>`
    SELECT updated_at FROM chat_runs WHERE run_id = ${runId}`
  return rows[0]?.updated_at ?? fallback
})

export const recoverChatRunInTransaction = Effect.fn("SqlitePersistence.recoverChatRun")(function* (
  sql: SqlClient.SqlClient,
  chatEvents: ChatEventStore["Service"],
  sessionEvents: SessionLifecycleEvents["Service"],
  run: ActiveChatRunRow,
  timestamp: string,
  cause: RecoveryCause
) {
  if (run.turn_id === null || run.turn_id.length === 0) {
    return yield* recoveryError(new Error(`Active Chat run ${run.run_id} has no durable turn id`))
  }
  const lastActive = yield* lastActiveAt(sql, run.run_id, timestamp)
  yield* sql`
    DELETE FROM tool_calls
    WHERE run_id = ${run.run_id}
      AND tool_name IN ${sql.in(REPLAYABLE_CONTROL_TOOLS)}
      AND status = 'running'
  `
  const spawned = yield* sql<SpawnedChildRow>`
    SELECT call.tool_call_id, call.arguments_json,
           child.session_id AS child_session_id, child.public_ref, child.name, child.metadata,
           run.run_id AS child_run_id
    FROM tool_calls AS call
    JOIN sessions AS child
      ON child.session_type = 'agent'
     AND child.parent_run_id = call.run_id
     AND child.parent_tool_call_id = call.tool_call_id
    JOIN chat_runs AS run ON run.session_id = child.session_id
    WHERE call.run_id = ${run.run_id}
      AND call.tool_name = 'spawn_agent'
      AND call.status = 'running'
    ORDER BY call.tool_call_id, run.started_at, run.run_id
  `
  const settledSpawns = new Set<string>()
  for (const row of spawned) {
    if (settledSpawns.has(row.tool_call_id)) continue
    settledSpawns.add(row.tool_call_id)
    const agent = readAgentSessionMetadata(
      yield* decodeJson(JsonObjectSchema, row.metadata ?? "{}")
    )
    yield* settleToolExecutionInTransaction(
      sql,
      {
        runId: run.run_id,
        sessionId: run.session_id,
        toolCallId: row.tool_call_id,
        toolName: "spawn_agent",
        arguments: yield* decodeJson(JsonObjectSchema, row.arguments_json),
        changesState: true
      },
      agentSpawnResult(
        { sessionId: row.child_session_id, sessionRef: row.public_ref, name: row.name },
        row.child_run_id,
        agent?.mode ?? "work",
        { runId: run.run_id, toolCallId: row.tool_call_id }
      ),
      DateTime.formatIso(yield* DateTime.now)
    )
  }
  yield* sql`
    DELETE FROM tool_calls
    WHERE run_id = ${run.run_id}
      AND tool_name = 'spawn_agent'
      AND status = 'running'
      AND NOT EXISTS (
        SELECT 1
        FROM sessions AS child
        WHERE child.session_type = 'agent'
          AND child.parent_run_id = tool_calls.run_id
          AND child.parent_tool_call_id = tool_calls.tool_call_id
      )
  `
  yield* markRunToolExecutionsUncertainInTransaction(sql, run.run_id, timestamp, cause.ending)
  const cancelled = run.cancellation_requested === 1
  const allowance = yield* sql<{ readonly expired: number }>`
    SELECT ${executionBudgetExpired(sql, sql`metadata_json`)} AS expired
    FROM chat_runs
    WHERE run_id = ${run.run_id}
  `
  if (cancelled)
    yield* settleUnstartedToolWorkForTerminalInTransaction(sql, run.run_id, timestamp, "cancelled")
  const unresolvedTools =
    cancelled || allowance[0]?.expired === 1
      ? []
      : yield* sql<UnresolvedToolRow>`
    SELECT call.run_id, call.session_id, call.tool_call_id, call.tool_name,
           call.changes_state, call.status
    FROM tool_calls AS call
    WHERE call.run_id = ${run.run_id}
      AND call.status = 'paused'
      AND NOT EXISTS (
        SELECT 1
        FROM tool_approvals AS approval
        WHERE approval.run_id = call.run_id
          AND approval.tool_call_id = call.tool_call_id
          AND approval.status = 'pending'
      )
    ORDER BY call.started_at, call.tool_call_id
  `
  const approvalDrafts: Array<EventDraft> = []
  for (const tool of unresolvedTools) {
    const pending: PendingToolApprovalInput = {
      runId: tool.run_id,
      sessionId: tool.session_id,
      toolCallId: tool.tool_call_id,
      toolName: tool.tool_name,
      kind: "tool_approval",
      action: "approve",
      scope: tool.changes_state === 1 ? "state_change" : "read_only",
      preview: cause.approvalDetail,
      description: cause.approvalDetail
    }
    const draft = yield* ensurePendingToolApprovalInTransaction(
      sql,
      sessionEvents,
      pending,
      timestamp,
      "recover"
    )
    if (draft !== null) approvalDrafts.push(draft)
  }
  const pendingApprovals = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM tool_approvals
    WHERE run_id = ${run.run_id} AND status = 'pending'
  `
  if (!cancelled && allowance[0]?.expired !== 1 && (pendingApprovals[0]?.count ?? 0) > 0) {
    const committed =
      approvalDrafts.length === 0
        ? null
        : yield* chatEvents.appendInTransaction({
            sessionId: run.session_id,
            events: approvalDrafts
          })
    for (const draft of approvalDrafts)
      yield* appendEscalatedApprovalDraft(sql, chatEvents, run.session_id, draft)
    if (committed === null) {
      yield* sql`
        UPDATE chat_runs
        SET status = 'pending', updated_at = ${timestamp}
        WHERE run_id = ${run.run_id}
          AND status IN ${activeRunStatusList}
      `
    } else {
      yield* sql`
        UPDATE chat_runs
        SET status = 'pending', updated_at = ${timestamp},
            last_seq = ${committed.headSequence}
        WHERE run_id = ${run.run_id}
          AND status IN ${activeRunStatusList}
      `
      yield* chatEvents.setCheckpointInTransaction(run.session_id, committed.headSequence)
    }
    yield* sql`
      UPDATE sessions
      SET last_activity = ${timestamp}
      WHERE session_id = ${run.session_id}
    `
    yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
    return { settled: false }
  }
  const projection = yield* loadActiveContext(sql, run.session_id).pipe(
    Effect.mapError(recoveryError)
  )
  const completed = yield* completedRunReply(sql, run.run_id, projection)
  const workflowChild = yield* scriptOwnsRun(sql, run.run_id)
  const resumable =
    !cancelled &&
    allowance[0]?.expired !== 1 &&
    !workflowChild &&
    projection.length > 0 &&
    completed === undefined
  if (resumable) {
    yield* sql`
      UPDATE chat_runs
      SET status = 'pending', updated_at = ${timestamp},
          metadata_json = CASE WHEN status = 'pending' THEN metadata_json ELSE json_set(
            metadata_json, '$.resumed',
            json_insert(
              COALESCE(json_extract(metadata_json, '$.resumed'), '[]'),
              '$[#]', json_object('at', ${timestamp}, 'cause', ${cause.stopReason})
            )
          ) END
      WHERE run_id = ${run.run_id}
        AND status IN ${activeRunStatusList}
    `
    yield* sql`
      UPDATE sessions
      SET last_activity = ${timestamp}
      WHERE session_id = ${run.session_id}
    `
    yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
    return { settled: false }
  }
  const finalReply = !cancelled ? completed : undefined
  const pendingRows = yield* sql<PendingMessageRow>`
    SELECT client_id, message_id, ${keyMessageJson(sql, "receipt")} AS message_json
    FROM chat_idempotency_keys AS receipt
    WHERE session_id = ${run.session_id}
      AND run_id = ${run.run_id}
      AND status = 'queued'
    ORDER BY created_at, client_id
  `
  const queued: Array<QueuedMessage> = []
  const knownIds = new Set(projection.map((message) => message.message_id))
  for (const row of pendingRows) {
    if (row.message_id === null || row.message_json === null) {
      return yield* recoveryError(new Error(`Queued Chat message for ${run.run_id} is missing`))
    }
    const message = yield* decodeJson(StoredMessageEnvelopeSchema, row.message_json)
    if (
      (message.role !== ROLE.user && message.role !== ROLE.interaction) ||
      message.message_id !== row.message_id ||
      message.client_id !== row.client_id ||
      knownIds.has(message.message_id)
    ) {
      return yield* recoveryError(new Error(`Queued Chat message for ${run.run_id} is corrupt`))
    }
    queued.push({ clientId: row.client_id, message })
    knownIds.add(message.message_id)
  }
  if (
    !workflowChild &&
    finalReply !== undefined &&
    queued.length > 0 &&
    allowance[0]?.expired !== 1
  ) {
    return yield* continueFinishedRunInTransaction(sql, chatEvents, sessionEvents, {
      run,
      queued,
      timestamp,
      cause
    })
  }
  const outcome = settlementOf(cancelled, finalReply)
  const settleCause =
    outcome._tag === RECOVERED_SETTLEMENT.fail && allowance[0]?.expired === 1
      ? allowanceEnded
      : cause
  const pendingMessages: Array<StoredMessageEnvelope> = [
    ...(yield* settleTerminalToolsInTransaction(sql, {
      ending: cause.ending,
      operation: outcome._tag,
      sessionId: run.session_id,
      runId: run.run_id,
      turnId: run.turn_id,
      terminalAt: timestamp,
      activeMessages: projection,
      appendedMessages: [],
      sessionEvents
    })),
    ...queued.map((item) => item.message)
  ]
  const nextProjection = [
    ...projection,
    ...(yield* appendRecoveredMessagesInTransaction(sql, run, pendingMessages, timestamp))
  ]
  const drafts: Array<{ readonly event: ChatProjectionEvent; readonly runId: string }> = []
  if (pendingMessages.length > 0) {
    drafts.push({
      event: { type: "transcript_changed" },
      runId: run.run_id
    })
  }
  const { openText } = yield* loadRunStreamedMessages(sql, run.session_id, run.run_id)
  for (const messageId of openText) {
    drafts.push({ event: textEnd(messageId, run.session_id, undefined), runId: run.run_id })
  }
  drafts.push({
    event: terminalEvent(outcome, run, nextProjection.length, settleCause),
    runId: run.run_id
  })
  const committed = yield* chatEvents.appendInTransaction({
    sessionId: run.session_id,
    events: drafts
  })

  yield* settleUnstartedToolWorkForTerminalInTransaction(
    sql,
    run.run_id,
    timestamp,
    settledToolStatus[outcome._tag]
  )
  switch (outcome._tag) {
    case RECOVERED_SETTLEMENT.finish:
      yield* sql`
        UPDATE chat_runs
        SET status = 'completed', stop_reason = 'end_turn',
            error_code = NULL, error_message = NULL,
            updated_at = ${timestamp}, ended_at = ${timestamp},
            last_seq = ${committed.headSequence},
            metadata_json = json_set(metadata_json, '$.recovered_terminal',
              json_object('at', ${timestamp}, 'cause', ${cause.stopReason}))
        WHERE run_id = ${run.run_id}
      `
      yield* sql`
        UPDATE chat_idempotency_keys
        SET status = CASE WHEN status = 'running' THEN 'completed' ELSE 'interrupted' END,
            updated_at = ${timestamp}
        WHERE run_id = ${run.run_id}
          AND status IN ${unfinishedRequestStatusList}
      `
      break
    case RECOVERED_SETTLEMENT.cancel:
    case RECOVERED_SETTLEMENT.fail:
      yield* sql`
        UPDATE chat_runs
        SET status = ${outcome._tag === RECOVERED_SETTLEMENT.cancel ? "cancelled" : "interrupted"},
            stop_reason = ${outcome._tag === RECOVERED_SETTLEMENT.cancel ? "cancelled" : settleCause.stopReason},
            error_code = ${outcome._tag === RECOVERED_SETTLEMENT.cancel ? null : settleCause.errorCode},
            error_message = ${outcome._tag === RECOVERED_SETTLEMENT.cancel ? null : settleCause.interruption},
            updated_at = ${timestamp},
            ended_at = ${timestamp},
            last_seq = ${committed.headSequence}
        WHERE run_id = ${run.run_id}
      `
      yield* sql`
        UPDATE chat_idempotency_keys
        SET status = ${outcome._tag === RECOVERED_SETTLEMENT.cancel ? "cancelled" : "interrupted"}, updated_at = ${timestamp}
        WHERE run_id = ${run.run_id}
          AND status IN ${unfinishedRequestStatusList}
      `
      break
  }
  yield* chatEvents.setCheckpointInTransaction(run.session_id, committed.headSequence)
  yield* settleRun(
    { sql, sessionEvents, chatEvents },
    {
      runId: run.run_id,
      now: timestamp,
      occurredAt: lastActive,
      terminal: runTerminal(outcome, settleCause)
    }
  )
  yield* sql`
    UPDATE sessions
    SET last_activity = ${timestamp}
    WHERE session_id = ${run.session_id}
  `
  yield* appendRunSettledInTransaction(sql, sessionEvents, run.run_id)
  yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
  return { settled: true }
})
