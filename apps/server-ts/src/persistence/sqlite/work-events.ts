import { outcomeSql } from "./automation-run-outcome.js"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import type { UnitOfWork } from "../unit-of-work.js"
import type { WorkStoreError } from "../work/store.js"
import { workError } from "./work-records.js"
import { taskEventSpeaksSql } from "./work-presentation.js"
import type { QueueWriter } from "./automation-enqueue.js"
import { journalTaskHistory, type AddedTaskHistory } from "./task-history.js"

export const makeWorkEvents = (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"]
) => {
  const taskEvent = (
    spaceId: string | null,
    itemId: string,
    eventType: string,
    summary: string,
    at: string,
    runId?: string,
    contentKind: "summary" | "result" = "summary",
    resultSummary?: string
  ): Effect.Effect<void, WorkStoreError, UnitOfWork> =>
    sql<AddedTaskHistory>`
    INSERT INTO space_task_events (
      space_id, item_id, run_ref, operation_index, event_type, summary, content_kind, created_at, result_summary
    ) VALUES (
      ${spaceId}, ${itemId}, ${runId ?? null}, NULL, ${eventType}, ${summary}, ${contentKind}, ${at}, ${resultSummary ?? null}
    )
    RETURNING event_id, item_id, run_ref
  `.pipe(
      Effect.flatMap((added) => journalTaskHistory(sql, sessionEvents, added)),
      Effect.mapError((cause) =>
        workError("storage", "Could not record the Space task event", cause)
      )
    )

  return { taskEvent }
}

export const recordTaskReport = (
  { sql, sessionEvents }: QueueWriter,
  runId: string
): Effect.Effect<void, WorkStoreError, UnitOfWork> =>
  sql<AddedTaskHistory>`
  INSERT INTO space_task_events (space_id, item_id, run_ref, operation_index, event_type, summary, created_at)
  SELECT task.space_id, attempt.item_id, attempt.chat_run_id, NULL, 'reported',
    substr(trim(replace(replace(attempt.result, char(13), ' '), char(10), ' ')), 1, 2000), attempt.ended_at
  FROM automation_runs AS attempt
  JOIN space_tasks AS task ON task.item_id = attempt.item_id
  WHERE attempt.chat_run_id = ${runId}
    AND ${outcomeSql(sql, sql`attempt`)} IN ('finished', 'blocked')
    AND attempt.ended_at IS NOT NULL AND length(trim(attempt.result)) > 0
    AND NOT EXISTS (SELECT 1 FROM space_task_events AS event
      WHERE event.run_ref = attempt.chat_run_id AND ${taskEventSpeaksSql(sql)})
  RETURNING event_id, item_id, run_ref
`.pipe(
    Effect.flatMap((added) => journalTaskHistory(sql, sessionEvents, added)),
    Effect.mapError((cause) => workError("storage", "Could not record the Task report", cause))
  )
