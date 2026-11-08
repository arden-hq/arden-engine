import { outcomeSql } from "./automation-run-outcome.js"
import { countsAsRun } from "./automation-skip-record.js"
import { Effect } from "effect"
import {
  inTaskWords,
  providerSentence,
  runFailureText,
  TRANSIENT_RUN_ERROR_CODES,
  type TransientRunErrorCode
} from "@arden-hq/protocol/chat"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { QueueWriter } from "./automation-enqueue.js"
import { journalTaskHistory } from "./task-history.js"
import { readJobTask } from "./space-job-rows.js"
import { spentBudgetStop } from "./task-block.js"
import { taskIsLive, taskMayWakeSql } from "./task-wake.js"
import { hasPendingTaskQuestion } from "./task-question-state.js"
import { inArdenWords } from "../restart-notice.js"
import { taskJobId } from "../space-job-id.js"
import { ownerWordsSql } from "./permission-offers.js"
import { iso } from "../../runtime/clock.js"
import {
  ladderStepMs,
  TASK_RETRY_LADDER_MS,
  TASK_STILL_LADDER_MS
} from "../automations/retry-ladders.js"

export type TaskStopCause = TransientRunErrorCode | "request_invalid" | "stalled" | "failed"
const STUCK_AFTER_WAKES = 3
const RECORD_ONLY_GAP_MS = 2 * 60_000
const TRANSIENT_CAUSE: Readonly<Record<TransientRunErrorCode, string>> = {
  provider_unavailable: "Couldn't reach the model provider",
  rate_limited: "The model provider asked Arden to slow down",
  run_interrupted: "A restart cut the run off"
}

const transientCode = (code: string | null | undefined): TransientRunErrorCode | undefined =>
  TRANSIENT_RUN_ERROR_CODES.find((candidate) => candidate === code)

const words = (value: string): string => value.trim().replaceAll(/\s+/g, " ")

export const failureWords = (error: string | null, errorCode: string | null = null): string => {
  const text = error === null ? "" : words(inArdenWords(error))
  if (text.length === 0) return "The run gave up after repeated failures."
  if (errorCode === "request_invalid" || errorCode === "model_unavailable")
    return inTaskWords(runFailureText(errorCode, text).text)
  const refusal = providerSentence(text)
  const status = /^(\w+) request failed with status (\d+)/.exec(text)
  if (refusal !== undefined && status !== null) {
    return `${status[1]} refused the run (HTTP ${status[2]}): ${words(refusal)}`.slice(0, 2_000)
  }
  return text.slice(0, 2_000)
}

const insertEvent = (
  { sql, sessionEvents }: QueueWriter,
  task: { readonly space_id: string | null; readonly item_id: string },
  runRef: string | null,
  eventType: "failed" | "retry_scheduled" | "stalled",
  summary: string,
  cause: TaskStopCause,
  now: string
) =>
  sql<{ readonly event_id: number; readonly item_id: string; readonly run_ref: string | null }>`
    INSERT INTO space_task_events (space_id, item_id, run_ref, operation_index, event_type, summary, stop_cause, created_at)
    VALUES (${task.space_id}, ${task.item_id}, ${runRef}, NULL, ${eventType}, ${summary}, ${cause}, ${now})
    RETURNING event_id, item_id, run_ref
  `.pipe(Effect.flatMap((added) => journalTaskHistory(sql, sessionEvents, added)))

const scheduleRetry = (sql: SqlClient.SqlClient, itemId: string, retryAt: string, now: string) =>
  sql`UPDATE space_tasks SET next_attempt_at = ${retryAt}, updated_at = MAX(updated_at, ${now})
    WHERE item_id = ${itemId}`

export const failTaskItem = Effect.fn("TaskNextMove.fail")(function* (
  writer: QueueWriter,
  input: {
    readonly itemId: string
    readonly error: string | null
    readonly errorCode: string | null
    readonly chatRunId: string | null
    readonly now: string
  }
) {
  const sql = writer.sql
  const task = yield* readJobTask(sql, input.itemId)
  if (task === null || !taskIsLive(task)) return
  const budgetStopped = (yield* spentBudgetStop(sql, input.itemId)) !== undefined
  const transient = transientCode(input.errorCode)
  if (transient !== undefined && !budgetStopped) {
    const streak = yield* sql<{ readonly failures: number }>`
      SELECT COUNT(*) AS failures FROM automation_runs AS attempt
      WHERE attempt.item_id = ${input.itemId} AND ${countsAsRun(sql, sql`attempt`)}
        AND ${outcomeSql(sql, sql`attempt`)} IN ('failed', 'interrupted')
        AND attempt.started_at > COALESCE((SELECT MAX(done.started_at) FROM automation_runs AS done
          WHERE done.item_id = ${input.itemId} AND done.status = 'completed'
            AND ${countsAsRun(sql, sql`done`)}), '')`
    const delay = ladderStepMs(TASK_RETRY_LADDER_MS, Math.max(streak[0]?.failures ?? 0, 1))
    if (delay !== undefined) {
      const retryAt = iso(Date.parse(input.now) + delay)
      yield* scheduleRetry(sql, input.itemId, retryAt, input.now)
      yield* insertEvent(
        writer,
        task,
        input.chatRunId,
        "retry_scheduled",
        `${TRANSIENT_CAUSE[transient]}; trying again at ${retryAt}.`,
        transient,
        input.now
      )
      return
    }
  }
  const transientEnd = budgetStopped
    ? "."
    : ` ${TASK_RETRY_LADDER_MS.length + 1} times in a row; stopped retrying.`
  const summary =
    transient === undefined
      ? failureWords(input.error, input.errorCode)
      : `${TRANSIENT_CAUSE[transient]}${transientEnd}`
  yield* insertEvent(
    writer,
    task,
    input.chatRunId,
    "failed",
    summary,
    transient ?? (input.errorCode === "request_invalid" ? "request_invalid" : "failed"),
    input.now
  )
  if (budgetStopped) return
  yield* sql`
    UPDATE space_tasks
    SET blocked = 0, waiting_on = NULL, updated_at = MAX(updated_at, ${input.now})
    WHERE item_id = ${input.itemId}
  `
})

export const endExternalWaitAtCheck = Effect.fn("TaskNextMove.endExternalWaitAtCheck")(function* (
  { sql, sessionEvents }: QueueWriter,
  itemId: string,
  now: string
) {
  const ended = yield* sql<{ readonly space_id: string | null; readonly item_id: string }>`
    UPDATE space_tasks SET blocked = 0, waiting_on = NULL, updated_at = MAX(updated_at, ${now})
    WHERE item_id = ${itemId} AND blocked = 1 AND waiting_on = 'external'
    RETURNING space_id, item_id
  `
  for (const task of ended)
    yield* sql<{
      readonly event_id: number
      readonly item_id: string
      readonly run_ref: string | null
    }>`
      INSERT INTO space_task_events (space_id, item_id, run_ref, operation_index, event_type, summary, created_at)
      VALUES (${task.space_id}, ${task.item_id}, NULL, NULL, 'unblocked', 'The booked check came due; no longer waiting.', ${now})
      RETURNING event_id, item_id, run_ref
    `.pipe(Effect.flatMap((added) => journalTaskHistory(sql, sessionEvents, added)))
})

const firmlyMovedAtSql = (sql: SqlClient.SqlClient, itemId: Statement.Fragment) => sql`COALESCE((
  SELECT MAX(moved.at) FROM (
    SELECT json_extract(evidence.value, '$.recorded_at') AS at
      FROM task_contract_lines AS line, json_each(line.evidence_json) AS evidence
      WHERE line.item_id = ${itemId} AND line.kind = 'criterion'
    UNION ALL SELECT MAX(line.created_at, COALESCE(line.retired_at, ''))
      FROM task_contract_lines AS line WHERE line.item_id = ${itemId}
    UNION ALL SELECT event.created_at FROM space_task_events AS event
      WHERE event.item_id = ${itemId}
        AND (event.event_type IN ('blocked', 'reopened')
          OR (event.event_type IN ('updated', 'scheduled') AND event.run_ref IS NULL))
    UNION ALL SELECT * FROM (SELECT message.created_at FROM space_tasks AS task
      JOIN session_messages AS message ON message.session_id = task.home_session_id
      WHERE task.item_id = ${itemId} AND task.runs_in = 'chat'
        AND ${ownerWordsSql(sql, sql`message`)}
      ORDER BY message.seq DESC LIMIT 1)
  ) AS moved), '')`

const recordChangedAtSql = (sql: SqlClient.SqlClient, itemId: Statement.Fragment) =>
  sql`COALESCE((SELECT CASE WHEN json_valid(task.continuation_context)
      THEN json_extract(task.continuation_context, '$.written_at') END
    FROM space_tasks AS task WHERE task.item_id = ${itemId}), '')`

const taskMovedAtSql = (sql: SqlClient.SqlClient, itemId: Statement.Fragment) =>
  sql`MAX(${firmlyMovedAtSql(sql, itemId)}, ${recordChangedAtSql(sql, itemId)})`

export const stallStreakSql = (sql: SqlClient.SqlClient, itemId: string) => sql`(
  SELECT COUNT(*) FROM space_task_events
  WHERE item_id = ${itemId} AND event_type = 'stalled'
    AND created_at > ${taskMovedAtSql(sql, sql`${itemId}`)})`

export const stoppedSinceMovedSql = (
  sql: SqlClient.SqlClient,
  itemId: Statement.Fragment
): Statement.Fragment => sql`EXISTS (SELECT 1 FROM space_task_events AS stop
  WHERE stop.item_id = ${itemId} AND stop.event_type = 'failed'
    AND stop.created_at > ${taskMovedAtSql(sql, itemId)})`

const ownerSpokeInRunSql = (sql: SqlClient.SqlClient, runId: string) => sql`EXISTS (
  SELECT 1 FROM chat_runs AS run
  JOIN session_messages AS turn ON turn.session_id = run.session_id
    AND turn.message_id = json_extract(run.metadata_json, '$.turn_id')
  JOIN session_messages AS message ON message.session_id = run.session_id
    AND message.seq >= turn.seq
  WHERE run.run_id = ${runId} AND ${ownerWordsSql(sql, sql`message`)})`

export const keepTaskMoving = Effect.fn("TaskNextMove.keepMoving")(function* (
  writer: QueueWriter,
  input: { readonly itemId: string; readonly chatRunId: string; readonly now: string }
) {
  const sql = writer.sql
  const wakeStart = sql`COALESCE(
    (SELECT run.started_at FROM chat_runs AS run WHERE run.run_id = ${input.chatRunId}),
    ${input.now})`
  const rows = yield* sql<{
    readonly space_id: string | null
    readonly item_id: string
    readonly runs_in: string
    readonly next_attempt_at: string | null
    readonly moved: number
    readonly recorded: number
    readonly booked: number
    readonly stalls: number
  }>`
    SELECT item.space_id, item.item_id, item.runs_in, item.next_attempt_at,
      (${firmlyMovedAtSql(sql, sql`item.item_id`)} >= ${wakeStart}
        OR ${ownerSpokeInRunSql(sql, input.chatRunId)}) AS moved,
      (${recordChangedAtSql(sql, sql`item.item_id`)} >= ${wakeStart}) AS recorded,
      -- This run booked a later check (task_wait with a time, task_update).
      (item.next_attempt_at > ${input.now} AND EXISTS (SELECT 1 FROM space_task_events AS booking
        WHERE booking.item_id = item.item_id AND booking.run_ref = ${input.chatRunId}
          AND booking.event_type IN ('scheduled', 'updated'))) AS booked,
      ${stallStreakSql(sql, input.itemId)} AS stalls
    FROM space_tasks AS item
    WHERE item.item_id = ${input.itemId}
      AND ${taskMayWakeSql(sql, "item")}
      AND NOT ${hasPendingTaskQuestion(sql, sql`item.item_id`)}
      AND NOT ${stoppedSinceMovedSql(sql, sql`item.item_id`)}
      AND NOT EXISTS (SELECT 1 FROM automation_event_queue AS waiting
        WHERE waiting.task_id = ${taskJobId(input.itemId)} AND waiting.claimed_at IS NULL)
  `
  const item = rows[0]
  if (item === undefined) return
  if (item.moved === 1) {
    if (item.runs_in === "background" && item.next_attempt_at === null)
      yield* scheduleRetry(sql, item.item_id, input.now, input.now)
    return
  }
  if (item.recorded === 1 || item.booked === 1) {
    const floor = iso(Date.parse(input.now) + RECORD_ONLY_GAP_MS)
    const nextAt =
      item.booked === 1 && item.next_attempt_at !== null && item.next_attempt_at > floor
        ? item.next_attempt_at
        : floor
    if (nextAt !== item.next_attempt_at) yield* scheduleRetry(sql, item.item_id, nextAt, input.now)
    return
  }
  const delay = ladderStepMs(TASK_STILL_LADDER_MS, item.stalls + 1)
  if (delay === undefined) {
    yield* failTaskItem(writer, {
      itemId: item.item_id,
      error: `Arden stopped this Task: its last ${STUCK_AFTER_WAKES} steps moved nothing (no criterion met, no change to its state record). Say how to go on, or Retry.`,
      errorCode: null,
      chatRunId: input.chatRunId,
      now: input.now
    })
    yield* sql`UPDATE space_tasks SET next_attempt_at = NULL WHERE item_id = ${item.item_id}`
    return
  }
  const retryAt = iso(Date.parse(input.now) + delay)
  yield* scheduleRetry(sql, item.item_id, retryAt, input.now)
  yield* insertEvent(
    writer,
    item,
    input.chatRunId,
    "stalled",
    `This step moved nothing: no criterion met, no change to its state record. Looking again at ${retryAt}.`,
    "stalled",
    input.now
  )
})

export const settleTaskRun = Effect.fn("TaskNextMove.settleTaskRun")(function* (
  writer: QueueWriter,
  runId: string,
  now: string
) {
  const sql = writer.sql
  const rows = yield* sql<{
    readonly item_id: string
    readonly status: string
    readonly error_code: string | null
    readonly error_message: string | null
  }>`
      SELECT json_extract(run.metadata_json, '$.run_context.task.item_id') AS item_id,
             run.status, run.error_code, run.error_message
      FROM chat_runs AS run JOIN sessions AS session ON session.session_id = run.session_id
      WHERE run.run_id = ${runId}
        AND json_extract(run.metadata_json, '$.run_context.task.item_id') IS NOT NULL
        AND session.session_type <> 'agent'
        AND NOT EXISTS (SELECT 1 FROM automation_runs AS attempt
          WHERE attempt.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
            AND attempt.task_id IS NOT NULL AND attempt.status = 'running')
    `
  const run = rows[0]
  if (run === undefined) return
  switch (run.status) {
    case "completed":
      return yield* keepTaskMoving(writer, { itemId: run.item_id, chatRunId: runId, now })
    case "error":
    case "failed":
    case "interrupted":
      return yield* failTaskItem(writer, {
        itemId: run.item_id,
        error: run.error_message,
        errorCode: run.error_code,
        chatRunId: runId,
        now
      })
    default:
      return
  }
})
