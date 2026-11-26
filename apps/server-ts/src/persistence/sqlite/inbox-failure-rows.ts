import type { SqlClient } from "effect/unstable/sql"
import { outcomeSql } from "./automation-run-outcome.js"
import { countsAsRun } from "./automation-skip-record.js"
import type { FailureRow } from "./inbox-failures.js"
import { failureNeedsOwner } from "./run-attention.js"
import { taskOpenSql } from "./task-status-sql.js"
import type { Statement } from "effect/unstable/sql/Statement"

const AUTOMATION_FAILED_PREFIX = "automation-failed:"

/**
 * The failures the Inbox shows: those started since `cutoff` (or at a time
 * that does not parse), and older ones whose Task is stuck. Each source is
 * read from those short lists, never from every failure on record: failed
 * attempts and failed endings by time (idx_automation_runs_status_started,
 * idx_run_endings_status_at), and the stuck Tasks (idx_space_tasks_stuck).
 * The final filter still decides; the lists only bound what it reads.
 */
export const failureRows = (
  sql: SqlClient.SqlClient,
  cutoff: string
): Statement<FailureRow> => sql<FailureRow>`
  WITH stuck AS (
    SELECT item_id FROM space_tasks AS stuck
    WHERE ${taskOpenSql("stuck")} AND stuck.owner = 'worker' AND stuck.next_attempt_at IS NULL
  ),
  -- The + drops the column's TEXT affinity so idx_chat_runs_task_item serves the join.
  stuck_chat AS (
    SELECT chat.run_id FROM stuck
    CROSS JOIN chat_runs AS chat
      ON json_extract(chat.metadata_json, '$.run_context.task.item_id') = +stuck.item_id
  ),
  failed_attempt AS (
    SELECT id FROM automation_runs
    WHERE status = 'failed' AND julianday(started_at) >= julianday(${cutoff})
    UNION SELECT id FROM automation_runs
    WHERE status = 'failed' AND julianday(started_at) IS NULL
    -- Each stuck Task's attempts by its item; the + keeps the status index from
    -- driving this join through every failed attempt.
    UNION SELECT attempt.id FROM stuck
    CROSS JOIN automation_runs AS attempt ON attempt.item_id = stuck.item_id
    WHERE +attempt.status = 'failed'
    UNION SELECT attempt.id FROM stuck_chat
    CROSS JOIN automation_runs AS attempt ON attempt.chat_run_id = stuck_chat.run_id
    WHERE attempt.status = 'failed'
  ),
  -- Endings of those attempts, and failed endings that have no attempt.
  failed_ending AS (
    SELECT attempt.chat_run_id AS run_id FROM failed_attempt
    CROSS JOIN automation_runs AS attempt ON attempt.id = failed_attempt.id
    WHERE attempt.chat_run_id IS NOT NULL
    UNION SELECT run_id FROM run_endings
    WHERE status = 'failed' AND decided = 1 AND julianday(occurred_at) >= julianday(${cutoff})
    UNION SELECT run_id FROM run_endings
    WHERE status = 'failed' AND decided = 1 AND julianday(occurred_at) IS NULL
    UNION SELECT run_id FROM stuck_chat
  ),
  candidate AS (
    SELECT 1 AS source, COALESCE(attempt.id, 0) AS id, attempt.task_id AS task_id, ending.run_id AS chat_run_id,
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
    FROM failed_ending
    CROSS JOIN run_endings AS ending ON ending.run_id = failed_ending.run_id
    JOIN chat_runs AS chat ON chat.run_id = ending.run_id
    JOIN sessions AS session ON session.session_id = chat.session_id
    LEFT JOIN automation_runs AS attempt ON attempt.chat_run_id = ending.run_id
    LEFT JOIN scheduled_tasks AS scheduled ON scheduled.task_id = attempt.task_id
    WHERE ${failureNeedsOwner(sql)}
      -- An attempt that settled otherwise (a handler's later batch completed it) is no failure.
      AND (attempt.id IS NULL
        OR (attempt.status = 'failed' AND ${outcomeSql(sql, sql`attempt`)} = 'failed'))
    UNION ALL
    SELECT 2, attempt.id, attempt.task_id, NULL, attempt.started_at, attempt.error, NULL,
      COALESCE(scheduled.owner_space_id, json_extract(attempt.origin, '$.space_id')),
      attempt.item_id, NULL
    FROM failed_attempt
    CROSS JOIN automation_runs AS attempt ON attempt.id = failed_attempt.id
    JOIN entity_events AS event ON event.key = ${AUTOMATION_FAILED_PREFIX} || attempt.id
    LEFT JOIN scheduled_tasks AS scheduled ON scheduled.task_id = attempt.task_id
    WHERE event.entity = 'automation' AND event.event = 'failed'
      AND attempt.status = 'failed' AND ${outcomeSql(sql, sql`attempt`)} = 'failed'
      -- An event about a run whose failed ending is listed above is that same failure.
      AND NOT EXISTS (SELECT 1 FROM run_endings
        WHERE run_id = event.run_id AND decided = 1 AND status = 'failed')
    UNION ALL
    SELECT 3, attempt.id, attempt.task_id, attempt.chat_run_id, attempt.started_at, attempt.error,
      (SELECT error_code FROM chat_runs WHERE run_id = attempt.chat_run_id),
      COALESCE((SELECT owner_space_id FROM scheduled_tasks WHERE task_id = attempt.task_id),
        json_extract(attempt.origin, '$.space_id'),
        (SELECT space_id FROM space_tasks WHERE item_id = attempt.item_id)),
      attempt.item_id,
      (SELECT status FROM chat_runs WHERE run_id = attempt.chat_run_id)
    FROM failed_attempt
    CROSS JOIN automation_runs AS attempt ON attempt.id = failed_attempt.id
    -- A superseded run (its Automation changed or turned off before it ran) is no failure.
    WHERE attempt.status = 'failed' AND ${outcomeSql(sql, sql`attempt`)} = 'failed'
      AND NOT EXISTS (SELECT 1 FROM run_endings
        WHERE run_id = attempt.chat_run_id AND decided = 1 AND status = 'failed')
      AND NOT EXISTS (SELECT 1 FROM entity_events
        WHERE key = ${AUTOMATION_FAILED_PREFIX} || attempt.id)
  )
  SELECT id, task_id, chat_run_id, started_at, error, error_code, space_id
  FROM candidate
  WHERE COALESCE(candidate.chat_status, '') <> 'cancelled'
    -- A run of the same Automation that completed after it, read from that
    -- Automation's counted completed runs in start order.
    AND NOT EXISTS (
      SELECT 1 FROM automation_runs AS completed
      WHERE completed.task_id = candidate.task_id AND completed.status = 'completed'
        AND ${countsAsRun(sql, sql`completed`)}
        AND julianday(completed.started_at) > julianday(candidate.started_at)
    )
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
  -- The Inbox groups rows in id order and keeps the first of equal ids; this
  -- is the order the sources were read in before (endings by run id first).
  ORDER BY id, source, chat_run_id
`
