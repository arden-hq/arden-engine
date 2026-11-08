import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { disposableForkSql } from "../schema/fork-disposition.js"
import { DateTime, Effect } from "effect"
import { SqlClient, type Statement } from "effect/unstable/sql"
import { ChatEventStore } from "../events/store.js"
import type { EventDraft } from "../events/model.js"
import { SessionLifecycleEvents } from "../sessions/events.js"
import { StorageStartupError } from "../service.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { runCancellationRequested } from "./run-cancellation.js"
import { executionBudgetExpired } from "./execution-budgets.js"
import { reconcileEndings } from "./run-ending.js"
import { settleRun } from "./run-settle.js"
import { settleTerminalToolsInTransaction } from "./tool-terminal.js"
import { decodeJson } from "./json.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import { completedRunReply } from "./run-completion.js"
import { scriptOwnsRun } from "./run-owner.js"
import { loadActiveContext } from "./active-context.js"
import { transactWithActiveContext } from "./active-context-stage.js"
import {
  markRunToolExecutionsUncertainInTransaction,
  settleToolExecutionInTransaction,
  settleUnstartedToolWorkForTerminalInTransaction
} from "./tool-receipts.js"
import {
  appendEscalatedApprovalDraft,
  ensurePendingToolApprovalInTransaction,
  type PendingToolApprovalInput
} from "./tool-approvals.js"
import { agentSpawnResult } from "./chat-agent-spawn.js"
import { JsonObjectSchema } from "../json.js"
import { readAgentSessionMetadata } from "../../sessions/agent-mode.js"
import { REPLAYABLE_CONTROL_TOOLS } from "../tools/tool-roles.js"
import type { PersistenceDeps } from "./deps.js"
import {
  type ActiveChatRunRow,
  appendRecoveredMessagesInTransaction,
  continueFinishedRunInTransaction,
  durableFinalReply,
  loadRunStreamedMessages,
  type QueuedMessage,
  type RecoveryCause,
  settledToolStatus,
  settlementOf,
  terminalEvent,
  runTerminal
} from "./recovery-finish.js"
import {
  activeRunStatusList,
  modelTurnRunStatusList,
  terminalRunStatusList,
  unfinishedRequestStatusList
} from "./status-sets.js"
import { RESTART_APPROVAL_DETAIL, RESTART_INTERRUPTION } from "../restart-notice.js"
import { appendRunSettledInTransaction } from "./run-settled.js"
import { decisionLineageSql } from "../schema/decision-visibility.js"

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

const serverRestart: RecoveryCause = {
  stopReason: "server_restart",
  interruption: RESTART_INTERRUPTION,
  errorCode: "run_interrupted",
  approvalDetail: RESTART_APPROVAL_DETAIL,
  ending: "process_restarted"
}

const lostOwner: RecoveryCause = {
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

const recoveryError = (cause: unknown): StorageStartupError =>
  new StorageStartupError({
    operation: "recover",
    message: "Could not interrupt active Chat runs after restart",
    cause
  })

const lastActiveAt = Effect.fn("SqlitePersistence.lastActiveAt")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  fallback: string
) {
  const rows = yield* sql<{ readonly updated_at: string }>`
    SELECT updated_at FROM chat_runs WHERE run_id = ${runId}`
  return rows[0]?.updated_at ?? fallback
})

const recoverChatRunInTransaction = Effect.fn("SqlitePersistence.recoverChatRun")(function* (
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
    SELECT client_id, message_id, message_json
    FROM chat_idempotency_keys
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
      message.role !== "user" ||
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
    outcome._tag === "fail" && allowance[0]?.expired === 1 ? allowanceEnded : cause
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
    drafts.push({
      event: { type: "TEXT_MESSAGE_END", message_id: messageId, session_id: run.session_id },
      runId: run.run_id
    })
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
    case "finish":
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
    case "cancel":
    case "fail":
      yield* sql`
        UPDATE chat_runs
        SET status = ${outcome._tag === "cancel" ? "cancelled" : "interrupted"},
            stop_reason = ${outcome._tag === "cancel" ? "cancelled" : settleCause.stopReason},
            error_code = ${outcome._tag === "cancel" ? null : settleCause.errorCode},
            error_message = ${outcome._tag === "cancel" ? null : settleCause.interruption},
            updated_at = ${timestamp},
            ended_at = ${timestamp},
            last_seq = ${committed.headSequence}
        WHERE run_id = ${run.run_id}
      `
      yield* sql`
        UPDATE chat_idempotency_keys
        SET status = ${outcome._tag === "cancel" ? "cancelled" : "interrupted"}, updated_at = ${timestamp}
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

const unrecoverable =
  "The assistant run was interrupted, and its unfinished steps could not be restored."

const quarantineChatRunInTransaction = Effect.fn("SqlitePersistence.quarantineChatRun")(function* (
  sql: SqlClient.SqlClient,
  chatEvents: ChatEventStore["Service"],
  sessionEvents: SessionLifecycleEvents["Service"],
  run: ActiveChatRunRow,
  timestamp: string,
  cause: RecoveryCause
) {
  const lastActive = yield* lastActiveAt(sql, run.run_id, timestamp)
  yield* markRunToolExecutionsUncertainInTransaction(sql, run.run_id, timestamp, cause.ending)
  yield* settleUnstartedToolWorkForTerminalInTransaction(sql, run.run_id, timestamp, "failed")
  const turnId = run.turn_id === null || run.turn_id.length === 0 ? undefined : run.turn_id
  const committed =
    turnId === undefined
      ? undefined
      : yield* chatEvents.appendInTransaction({
          sessionId: run.session_id,
          events: [
            {
              event: {
                type: "RUN_ERROR",
                run_id: run.run_id,
                session_id: run.session_id,
                turn_id: turnId,
                code: "run_interrupted",
                message: unrecoverable
              },
              runId: run.run_id
            }
          ]
        })
  yield* sql`
    UPDATE chat_runs
    SET status = 'interrupted',
        stop_reason = 'recovery_failed',
        error_code = 'run_interrupted',
        error_message = ${unrecoverable},
        updated_at = ${timestamp},
        ended_at = ${timestamp},
        last_seq = COALESCE(${committed?.headSequence ?? null}, last_seq)
    WHERE run_id = ${run.run_id}
  `
  yield* sql`
    UPDATE chat_idempotency_keys
    SET status = 'interrupted', updated_at = ${timestamp}
    WHERE run_id = ${run.run_id}
      AND status IN ${unfinishedRequestStatusList}
  `
  if (committed !== undefined) {
    yield* chatEvents.setCheckpointInTransaction(run.session_id, committed.headSequence)
  }
  const reply = yield* durableFinalReply(sql, run.run_id)
  yield* settleRun(
    { sql, sessionEvents, chatEvents },
    {
      runId: run.run_id,
      now: timestamp,
      occurredAt: lastActive,
      terminal: {
        status: "failed",
        error:
          reply === undefined
            ? unrecoverable
            : `${unrecoverable}\n\nIts final reply before it stopped:\n\n${reply}`
      }
    }
  )
  yield* sql`
    UPDATE sessions
    SET last_activity = ${timestamp}
    WHERE session_id = ${run.session_id}
  `
  yield* appendRunSettledInTransaction(sql, sessionEvents, run.run_id)
  yield* sessionEvents.appendInTransaction("session_activity", run.session_id)
})

interface RecoveryCandidate extends ActiveChatRunRow {
  readonly started_at: string
}

const RECOVERY_PAGE_SIZE = 100

const recoverEachChatRun = Effect.fn("SqlitePersistence.recoverEachChatRun")(function* (
  {
    writer,
    chatEvents,
    sessionEvents
  }: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents">,
  select: (
    where: Statement.Fragment
  ) => Effect.Effect<ReadonlyArray<RecoveryCandidate>, unknown, UnitOfWork>,
  cause: RecoveryCause
) {
  const sql = writer.sql
  const settled: Array<string> = []
  let after: RecoveryCandidate | undefined
  while (true) {
    const where =
      after === undefined
        ? sql`1`
        : sql`
      (run.session_id, run.started_at, run.run_id) > (${after.session_id}, ${after.started_at}, ${after.run_id})`
    const runs = yield* writer.transact(select(where)).pipe(Effect.mapError(recoveryError))
    if (runs.length === 0) break
    for (const candidate of runs) {
      const recover = transactWithActiveContext(
        writer,
        "ordinary",
        { sessionId: candidate.session_id },
        Effect.gen(function* () {
          const [run] = yield* select(sql`run.run_id = ${candidate.run_id}`)
          if (run === undefined) return { settled: false }
          const timestamp = DateTime.formatIso(yield* DateTime.now)
          return yield* recoverChatRunInTransaction(
            sql,
            chatEvents,
            sessionEvents,
            run,
            timestamp,
            cause
          )
        })
      )
      const recovered = yield* recover.pipe(
        Effect.catch((failure) =>
          Effect.logError("Chat run recovery failed; quarantining the run").pipe(
            Effect.annotateLogs({
              runId: candidate.run_id,
              sessionId: candidate.session_id,
              failure
            }),
            Effect.andThen(
              writer.transact(
                Effect.gen(function* () {
                  const [run] = yield* select(sql`run.run_id = ${candidate.run_id}`)
                  if (run === undefined) return { settled: false }
                  const timestamp = DateTime.formatIso(yield* DateTime.now)
                  yield* quarantineChatRunInTransaction(
                    sql,
                    chatEvents,
                    sessionEvents,
                    run,
                    timestamp,
                    cause
                  )
                  return { settled: true }
                })
              )
            ),
            Effect.catch((quarantineFailure) =>
              Effect.logError("Chat run quarantine failed; the run stays open").pipe(
                Effect.annotateLogs({
                  runId: candidate.run_id,
                  sessionId: candidate.session_id,
                  failure: quarantineFailure
                }),
                Effect.as({ settled: false })
              )
            )
          )
        )
      )
      if (recovered.settled) settled.push(candidate.run_id)
    }
    after = runs[runs.length - 1]
  }
  return settled
})

export const interruptActiveChatRunsAfterRestart = Effect.fn(
  "SqlitePersistence.interruptActiveChatRunsAfterRestart"
)(function* (deps: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents">) {
  const sql = deps.writer.sql
  yield* deps.writer
    .transact(
      Effect.gen(function* () {
        const stale = yield* sql<{
          readonly run_id: string
          readonly session_id: string
          readonly tool_call_id: string
        }>`SELECT approval.run_id, approval.session_id, approval.tool_call_id
          FROM tool_approvals AS approval
          JOIN chat_runs AS run ON run.run_id = approval.run_id
          WHERE approval.kind = 'tool_outcome' AND approval.status = 'pending'
            AND run.status IN ${terminalRunStatusList}`
        for (const source of stale) {
          const lineage = yield* sql.unsafe<{
            readonly session_id: string
            readonly session_type: string
            readonly edge_valid: number
          }>(decisionLineageSql("?"), [source.session_id])
          const valid =
            lineage.length > 0 &&
            lineage.every((row) => row.edge_valid === 1) &&
            lineage.some((row) => row.session_type !== "agent")
          const side = valid ? lineage.find((row) => row.session_type === "chat") : undefined
          if (side !== undefined) {
            const retained = yield* sql`SELECT 1 FROM session_fork_requests AS fork
              JOIN sessions AS parent ON parent.session_id = fork.source_session_id
                AND parent.session_type = 'chat'
              WHERE fork.child_session_id = ${side.session_id} AND fork.state = 'ready'
                AND json_valid(fork.request_json)
                AND ${sql.literal(disposableForkSql("fork"))}
              LIMIT 1`
            if (retained.length > 0) continue
          }
          yield* sql`DELETE FROM tool_approvals
            WHERE run_id = ${source.run_id} AND tool_call_id = ${source.tool_call_id}
              AND kind = 'tool_outcome' AND status = 'pending'`
        }
      })
    )
    .pipe(Effect.mapError(recoveryError))
  yield* recoverEachChatRun(
    deps,
    (where) =>
      sql<RecoveryCandidate>`
        SELECT run.run_id, run.session_id, run.started_at,
               json_extract(run.metadata_json, '$.turn_id') AS turn_id,
               CASE WHEN ${runCancellationRequested(sql, sql`run.metadata_json`)} OR EXISTS (
                 SELECT 1 FROM space_tasks AS task
                 WHERE task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
                   AND task.status = 'cancelled'
               ) THEN 1 ELSE 0 END AS cancellation_requested,
               run.assistant_message_id
        FROM chat_runs AS run
        WHERE run.status IN ${activeRunStatusList}
          AND ${where}
        ORDER BY run.session_id, run.started_at, run.run_id
        LIMIT ${RECOVERY_PAGE_SIZE}
      `,
    serverRestart
  )
  yield* deps.writer
    .transact(
      Effect.gen(function* () {
        const timestamp = DateTime.formatIso(yield* DateTime.now)
        const ended = yield* sql<{ readonly run_id: string }>`
          SELECT DISTINCT call.run_id FROM tool_calls AS call
          JOIN chat_runs AS run ON run.run_id = call.run_id
          WHERE call.status = 'running' AND run.status NOT IN ${activeRunStatusList}`
        for (const { run_id } of ended)
          yield* markRunToolExecutionsUncertainInTransaction(
            sql,
            run_id,
            timestamp,
            serverRestart.ending
          )
      })
    )
    .pipe(Effect.mapError(recoveryError))
  yield* deps.writer.transact(reconcileEndings(sql)).pipe(Effect.mapError(recoveryError))
})

export const interruptStrandedChatRuns = Effect.fn("SqlitePersistence.interruptStrandedChatRuns")(
  function* ({
    ownedRunIds,
    ...deps
  }: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents"> & {
    readonly ownedRunIds: ReadonlyArray<string>
  }) {
    const sql = deps.writer.sql
    const settled = yield* recoverEachChatRun(
      deps,
      (where) =>
        sql<RecoveryCandidate>`
        SELECT run.run_id, run.session_id, run.started_at,
               json_extract(run.metadata_json, '$.turn_id') AS turn_id,
               ${runCancellationRequested(sql, sql`run.metadata_json`)} AS cancellation_requested,
               run.assistant_message_id
        FROM chat_runs AS run
        WHERE (
            -- Turns the lost process was running; their background work is the script's.
            run.status IN ${modelTurnRunStatusList}
            OR (run.status = 'pending' AND ${executionBudgetExpired(sql, sql`run.metadata_json`)})
          )
          AND ${where}
          AND ${ownedRunIds.length === 0 ? sql`1` : sql`run.run_id NOT IN ${sql.in(ownedRunIds)}`}
        ORDER BY run.session_id, run.started_at, run.run_id
        LIMIT ${RECOVERY_PAGE_SIZE}
      `,
      lostOwner
    )
    yield* deps.writer.transact(reconcileEndings(sql)).pipe(Effect.mapError(recoveryError))
    return settled
  }
)
