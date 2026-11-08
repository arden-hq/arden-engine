import type { RunQuestion } from "@arden-hq/protocol/runs"
import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { workError } from "./work-records.js"
import { journalTaskHistory, type AddedTaskHistory } from "./task-history.js"
import { taskOpenSql } from "./task-status-sql.js"
import { blockTaskOnYou } from "./task-block.js"

export const holdQuestionTask = Effect.fn("WorkQuestions.holdTask")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly question: RunQuestion
  readonly now: string
}) {
  const { sql, question, now } = options
  const binding = question.context.task
  if (!binding) return yield* workError("invalid", "Only a Task question can be kept on hold")
  const rows = yield* sql<{
    readonly space_id: string | null
    readonly generation: number
    readonly updated_at: string
  }>`
    SELECT task.space_id, task.generation, task.updated_at FROM space_tasks AS task
    LEFT JOIN spaces AS space ON space.space_id = task.space_id
    WHERE task.item_id = ${binding.item_id} AND task.generation = ${binding.generation}
      AND ${taskOpenSql("task")}
      AND (task.space_id IS NULL OR space.archived_at IS NULL)`
  const task = rows[0]
  if (!task)
    return yield* workError(
      "conflict",
      "This question no longer belongs to the current Task attempt"
    )
  const previous = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(task.updated_at)
  const at =
    now > task.updated_at ? now : DateTime.formatIso(DateTime.add(previous, { milliseconds: 1 }))
  yield* blockTaskOnYou(sql, { where: sql`item_id = ${binding.item_id}`, at, fence: true })
  yield* sql`INSERT INTO space_task_holds (item_id, question_id, task_generation, acknowledged_at)
    VALUES (${binding.item_id}, ${question.question_id}, ${task.generation + 1}, ${now})
    ON CONFLICT(item_id) DO UPDATE SET question_id = excluded.question_id,
      task_generation = excluded.task_generation, acknowledged_at = excluded.acknowledged_at`
  yield* makeSpaceJobSql(sql, options.sessionEvents).stopTask(binding.item_id)
  yield* sql`UPDATE automation_deliveries SET status = 'discarded',
    payload = json_set(payload, '$.withdrawal', json_object('at', ${now}, 'reason', 'task_changed'))
    WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'answer'
      AND json_extract(payload, '$.context.task.item_id') = ${binding.item_id}`
  yield* journalTaskHistory(
    sql,
    options.sessionEvents,
    yield* sql<AddedTaskHistory>`INSERT INTO space_task_events (space_id, item_id, run_ref, event_type, summary, created_at)
      VALUES (${task.space_id}, ${binding.item_id}, ${question.run_id}, 'on_hold',
        'Kept on hold. No automatic recheck.', ${at})
      RETURNING event_id, item_id, run_ref`
  )
  return { spaceId: task.space_id, itemId: binding.item_id }
})
