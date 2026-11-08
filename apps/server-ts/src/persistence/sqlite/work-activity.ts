import { countsAsRun } from "./automation-skip-record.js"
import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type {
  SpaceTask,
  SpaceTaskActivity,
  SpaceTaskStopKind
} from "@arden-hq/protocol/spaces/work"
import { workError } from "./work-records.js"
import { taskHasHold } from "./task-hold-state.js"
import { hasPendingTaskQuestion } from "./task-question-state.js"
import { activeRunStatusList } from "./status-sets.js"
import { inTaskWords } from "@arden-hq/protocol/chat"
import { failureWords, type TaskStopCause } from "./task-next-move.js"
import { inArdenWords } from "../restart-notice.js"
import { taskOpenSql } from "./task-status-sql.js"

// The unary `+` drops the column's TEXT affinity, which otherwise keeps SQLite off
// `idx_chat_runs_task_item`.
/** One current-state projection for every Task surface. A completed attempt
 * does not complete the Task; questions outlive their Run, not their generation.
 * Runs are found by `idx_chat_runs_task_item`; the unary `+` drops the
 * column's TEXT affinity, which otherwise keeps SQLite off that index.
 *
 * A Task is stopped when its last attempt failed, and also when Arden's Task
 * has run (in any generation: a Space setting change bumps every Task's) but
 * nothing will run it again: no next check, nothing queued, nothing asked, no
 * answer on its way. Nothing else would show that state. */
export const workActivitySql = (sql: SqlClient.SqlClient, task: Statement.Fragment) => sql`CASE
      WHEN ${task}.status <> 'open' THEN 'idle'
      WHEN ${hasPendingTaskQuestion(sql, sql`${task}.item_id`)} THEN 'needs_you'
      WHEN ${taskHasHold(sql, task)} THEN 'on_hold'
      WHEN EXISTS (SELECT 1 FROM chat_runs AS r
        WHERE json_extract(r.metadata_json, '$.run_context.task.item_id') = +${task}.item_id
          AND json_extract(r.metadata_json, '$.run_context.task.generation') = ${task}.generation
          AND r.status IN ${activeRunStatusList}) THEN 'working'
      -- A Task that runs in its chat moves on with any turn there.
      WHEN ${task}.runs_in = 'chat' AND ${task}.owner = 'worker' AND ${task}.blocked = 0
        AND EXISTS (SELECT 1 FROM chat_runs AS r
          WHERE r.session_id = ${task}.home_session_id AND r.status IN ${activeRunStatusList}) THEN 'working'
      WHEN ${task}.blocked = 1 THEN 'waiting'
      WHEN (SELECT r.status FROM automation_runs AS r WHERE r.item_id = ${task}.item_id
        AND r.task_generation = ${task}.generation AND ${countsAsRun(sql, sql`r`)} ORDER BY r.id DESC LIMIT 1)
        IN ('failed', 'interrupted', 'cancelled') THEN 'stopped'
      WHEN ${task}.owner = 'worker' AND ${task}.next_attempt_at IS NULL
        AND EXISTS (SELECT 1 FROM chat_runs AS r
          WHERE json_extract(r.metadata_json, '$.run_context.task.item_id') = +${task}.item_id)
        AND NOT EXISTS (SELECT 1 FROM scheduled_tasks AS job
          JOIN automation_event_queue AS pending ON pending.task_id = job.task_id
          WHERE job.owner_task_id = ${task}.item_id)
        AND NOT EXISTS (SELECT 1 FROM automation_deliveries AS answer
          WHERE answer.status = 'pending' AND json_extract(answer.payload, '$.kind') = 'answer'
            AND json_extract(answer.payload, '$.context.task.item_id') = ${task}.item_id) THEN 'stopped'
      ELSE 'idle' END`

interface StopFacts {
  readonly item_id: string
  readonly stop_cause: TaskStopCause | null
  readonly event_summary: string | null
  readonly event_at: string | null
  readonly run_status: string | null
  readonly run_error_code: string | null
  readonly run_error: string | null
  readonly run_at: string | null
}

interface Stop {
  readonly kind: SpaceTaskStopKind
  readonly reason: string
}

const stopOf = (facts: StopFacts): Stop => {
  if (
    facts.event_summary !== null &&
    facts.event_at !== null &&
    (facts.run_at === null || facts.event_at >= facts.run_at)
  ) {
    return {
      kind: eventStopKind(facts.stop_cause),
      reason: inTaskWords(inArdenWords(facts.event_summary))
    }
  }
  switch (facts.run_status) {
    case "cancelled":
      return {
        kind: "cancelled",
        reason: "Its last run was stopped, and nothing is scheduled to run it again."
      }
    case "interrupted":
    case "error":
    case "failed":
      return facts.run_error_code === "run_interrupted"
        ? { kind: "restart", reason: "A restart cut its last run off, and nothing tried it again." }
        : {
            kind: "failed",
            reason: inTaskWords(
              `Its last run failed, and nothing tried it again: ${failureWords(facts.run_error, facts.run_error_code)}`
            )
          }
    case null:
    default:
      return {
        kind: "stalled",
        reason:
          "Its last run ended without finishing it, booking a next check or asking you, so nothing will run it again."
      }
  }
}

const eventStopKind = (cause: TaskStopCause | null): SpaceTaskStopKind => {
  switch (cause) {
    case "run_interrupted":
      return "restart"
    case "stalled":
      return "stalled"
    case "request_invalid":
    case "provider_unavailable":
    case "rate_limited":
    case "failed":
    case null:
      return "failed"
  }
}

const readStopFacts = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  itemIds: ReadonlyArray<string>
) {
  return yield* sql<StopFacts>`
    SELECT task.item_id,
      event.stop_cause, event.summary AS event_summary, event.created_at AS event_at,
      last_end.status AS run_status, last_end.error_code AS run_error_code,
      last_end.error AS run_error, last_end.started_at AS run_at
    FROM space_tasks AS task
    LEFT JOIN space_task_events AS event ON event.event_id = (
      SELECT stop.event_id FROM space_task_events AS stop
      WHERE stop.item_id = task.item_id
        AND stop.event_type IN ('failed', 'stalled', 'retry_scheduled', 'blocked')
      ORDER BY stop.event_id DESC LIMIT 1)
    LEFT JOIN (
      SELECT ends.item_id, ends.status, ends.error_code, ends.error, ends.started_at,
        ROW_NUMBER() OVER (PARTITION BY ends.item_id ORDER BY ends.started_at DESC) AS rank
      FROM (
        SELECT attempt.item_id, attempt.status, chat.error_code,
          COALESCE(chat.error_message, attempt.error) AS error, attempt.started_at
        FROM automation_runs AS attempt
        LEFT JOIN chat_runs AS chat ON chat.run_id = attempt.chat_run_id
        WHERE attempt.item_id IN ${sql.in(itemIds)} AND ${countsAsRun(sql, sql`attempt`)}
        UNION ALL
        SELECT owner.item_id, chat.status, chat.error_code, chat.error_message, chat.started_at
        FROM space_tasks AS owner
        JOIN chat_runs AS chat
          ON json_extract(chat.metadata_json, '$.run_context.task.item_id') = +owner.item_id
        WHERE owner.item_id IN ${sql.in(itemIds)}
      ) AS ends
    ) AS last_end ON last_end.item_id = task.item_id AND last_end.rank = 1
    WHERE task.item_id IN ${sql.in(itemIds)}
  `
})

export const readWorkState = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  itemIds: ReadonlyArray<string>
) {
  if (itemIds.length === 0)
    return new Map<string, Pick<SpaceTask, "activity" | "hold" | "stop_reason" | "stop_kind">>()
  const rows = yield* sql<{
    readonly item_id: string
    readonly activity: SpaceTaskActivity
    readonly question_id: string | null
    readonly acknowledged_at: string | null
  }>`
    SELECT task.item_id, ${workActivitySql(sql, sql`task`)} AS activity, hold.question_id, hold.acknowledged_at
    FROM space_tasks AS task LEFT JOIN space_task_holds AS hold
      ON hold.item_id = task.item_id AND hold.task_generation = task.generation
        AND ${taskOpenSql("task")} AND task.blocked = 1
    WHERE task.item_id IN ${sql.in(itemIds)}
  `.pipe(Effect.mapError((cause) => workError("storage", "Could not read Task activity", cause)))
  const stopped = rows.filter((row) => row.activity === "stopped").map((row) => row.item_id)
  const facts =
    stopped.length === 0
      ? []
      : yield* readStopFacts(sql, stopped).pipe(
          Effect.mapError((cause) =>
            workError("storage", "Could not read why a Task stopped", cause)
          )
        )
  const stops = new Map(facts.map((row) => [row.item_id, stopOf(row)]))
  return new Map(
    rows.map((row) => [
      row.item_id,
      {
        activity: row.activity,
        hold:
          row.question_id !== null && row.acknowledged_at !== null
            ? { question_id: row.question_id, acknowledged_at: row.acknowledged_at }
            : null,
        stop_reason: row.activity === "stopped" ? (stops.get(row.item_id)?.reason ?? null) : null,
        stop_kind: row.activity === "stopped" ? (stops.get(row.item_id)?.kind ?? null) : null
      }
    ])
  )
})
