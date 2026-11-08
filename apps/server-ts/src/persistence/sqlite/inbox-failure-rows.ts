import type { SqlClient } from "effect/unstable/sql"
import { outcomeSql } from "./automation-run-outcome.js"
import { countsAsRun } from "./automation-skip-record.js"
import type { FailureRow } from "./inbox-failures.js"
import { failureNeedsOwner } from "./run-attention.js"
import { taskOpenSql } from "./task-status-sql.js"

const AUTOMATION_FAILED_PREFIX = "automation-failed:"

export const failureRows = (sql: SqlClient.SqlClient, cutoff: string) => sql<FailureRow>`
  -- Each Automation's latest completed start, found once from the index,
  -- instead of a scan of the Automation's runs for every failure.
  WITH latest_completed AS (
    SELECT task_id AS completed_task_id, MAX(julianday(started_at)) AS completed_started
    FROM automation_runs
    WHERE status = 'completed' AND task_id IS NOT NULL
      AND ${countsAsRun(sql, sql`automation_runs`)}
    GROUP BY task_id
  ),
  candidate AS (
    SELECT COALESCE(attempt.id, 0) AS id, attempt.task_id AS task_id, ending.run_id AS chat_run_id,
      COALESCE(attempt.started_at, ending.occurred_at) AS started_at,
      CASE WHEN attempt.id IS NULL THEN ending.text ELSE attempt.error END AS error,
      chat.error_code AS error_code,
      COALESCE(scheduled.owner_space_id, json_extract(attempt.origin, '$.space_id'),
        (SELECT space_id FROM space_tasks WHERE item_id = COALESCE(attempt.item_id,
          json_extract(chat.metadata_json, '$.run_context.task.item_id'))),
        session.space_id) AS space_id,
      COALESCE(attempt.item_id,
        json_extract(chat.metadata_json, '$.run_context.task.item_id')) AS item_id,
      chat.status AS chat_status
    FROM run_endings AS ending
    JOIN chat_runs AS chat ON chat.run_id = ending.run_id
    JOIN sessions AS session ON session.session_id = chat.session_id
    LEFT JOIN automation_runs AS attempt ON attempt.chat_run_id = ending.run_id
    LEFT JOIN scheduled_tasks AS scheduled ON scheduled.task_id = attempt.task_id
    WHERE ${failureNeedsOwner(sql)}
      -- An attempt that settled otherwise (a handler's later batch completed it) is no failure.
      AND (attempt.id IS NULL
        OR (attempt.status = 'failed' AND ${outcomeSql(sql, sql`attempt`)} = 'failed'))
    UNION ALL
    SELECT attempt.id, attempt.task_id, NULL, attempt.started_at, attempt.error, NULL,
      COALESCE(scheduled.owner_space_id, json_extract(attempt.origin, '$.space_id')),
      attempt.item_id, NULL
    FROM entity_events AS event
    JOIN automation_runs AS attempt
      ON attempt.id = CAST(substr(event.key, ${AUTOMATION_FAILED_PREFIX.length + 1}) AS INTEGER)
    LEFT JOIN scheduled_tasks AS scheduled ON scheduled.task_id = attempt.task_id
    WHERE event.entity = 'automation' AND event.event = 'failed'
      AND attempt.status = 'failed' AND ${outcomeSql(sql, sql`attempt`)} = 'failed'
    UNION ALL
    SELECT attempt.id, attempt.task_id, attempt.chat_run_id, attempt.started_at, attempt.error,
      (SELECT error_code FROM chat_runs WHERE run_id = attempt.chat_run_id),
      COALESCE((SELECT owner_space_id FROM scheduled_tasks WHERE task_id = attempt.task_id),
        json_extract(attempt.origin, '$.space_id'),
        (SELECT space_id FROM space_tasks WHERE item_id = attempt.item_id)),
      attempt.item_id,
      (SELECT status FROM chat_runs WHERE run_id = attempt.chat_run_id)
    FROM automation_runs AS attempt
    -- Its outcome says failed; the status narrows the scan to its index. A superseded
    -- run (its Automation changed or turned off before it ran) is no failure.
    WHERE attempt.status = 'failed' AND ${outcomeSql(sql, sql`attempt`)} = 'failed'
      AND NOT EXISTS (SELECT 1 FROM run_endings
        WHERE run_id = attempt.chat_run_id AND decided = 1 AND status = 'failed')
      AND NOT EXISTS (SELECT 1 FROM entity_events
        WHERE key = ${AUTOMATION_FAILED_PREFIX} || attempt.id)
  )
  SELECT id, task_id, chat_run_id, started_at, error, error_code, space_id
  FROM candidate
  LEFT JOIN latest_completed ON latest_completed.completed_task_id = candidate.task_id
  WHERE COALESCE(candidate.chat_status, '') <> 'cancelled'
    AND COALESCE(latest_completed.completed_started > julianday(candidate.started_at), 0) = 0
    AND (
      julianday(candidate.started_at) IS NULL OR
      julianday(candidate.started_at) >= julianday(${cutoff}) OR
      -- A failure whose Task is still stuck — open, the worker's, nothing
      -- scheduled — is not history: it is the only sign that Task stopped.
      EXISTS (
        SELECT 1 FROM space_tasks AS stuck
        WHERE stuck.item_id = candidate.item_id
          AND ${taskOpenSql("stuck")} AND stuck.owner = 'worker' AND stuck.next_attempt_at IS NULL
      )
    )
    -- A Task whose next try is already scheduled is being handled: its
    -- failure surfaces only if the retries run out.
    AND NOT EXISTS (
      SELECT 1 FROM space_tasks AS task
      WHERE task.item_id = candidate.item_id AND ${taskOpenSql("task")}
        AND task.next_attempt_at IS NOT NULL
    )
`
