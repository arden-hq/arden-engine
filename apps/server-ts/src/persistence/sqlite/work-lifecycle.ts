import { Effect } from "effect"
import type { QueueWriter } from "./automation-enqueue.js"
import { journalTaskHistory, type AddedTaskHistory } from "./task-history.js"

export const reopenDeferredTasks = Effect.fn(function* (
  { sql, sessionEvents }: QueueWriter,
  now: string
) {
  const rows = yield* sql<{
    readonly item_id: string
    readonly space_id: string | null
    readonly text: string
  }>`
    UPDATE space_tasks SET status = 'open', next_attempt_at = NULL, updated_at = ${now}
    WHERE item_id IN (SELECT item.item_id FROM space_tasks AS item
      LEFT JOIN spaces AS space ON space.space_id = item.space_id
      WHERE item.status = 'deferred'
        AND (item.space_id IS NULL OR space.archived_at IS NULL)
        AND item.next_attempt_at IS NOT NULL AND item.next_attempt_at <= ${now}
      ORDER BY item.next_attempt_at, item.item_id LIMIT 100)
    RETURNING item_id, space_id, text
  `
  for (const row of rows) {
    yield* journalTaskHistory(
      sql,
      sessionEvents,
      yield* sql<AddedTaskHistory>`INSERT INTO space_task_events (space_id, item_id, event_type, summary, created_at)
        VALUES (${row.space_id}, ${row.item_id}, 'reopened', ${row.text}, ${now})
        RETURNING event_id, item_id, run_ref`
    )
  }
  return rows
})
