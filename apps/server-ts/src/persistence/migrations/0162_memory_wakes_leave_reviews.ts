import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** Deletes the unclaimed `wiki.changed` event rows of `space_review` jobs that name no run.
 * Claimed rows, rows that name a run, and other rows and jobs are left as they are. */
const up = (database: DatabaseSync): void => {
  database.exec(`DELETE FROM automation_event_queue
    WHERE claimed_at IS NULL AND source = 'event'
      AND json_extract(context, '$.automation_run_id') IS NULL
      AND json_extract(context, '$.trigger_context_snapshot.event_type') = 'wiki.changed'
      AND task_id IN (SELECT task_id FROM scheduled_tasks WHERE purpose = 'space_review')`)
}

export const memoryWakesLeaveReviews: Migration = {
  version: 162,
  name: "memory_wakes_leave_reviews",
  foreignKeys: { kind: "enforced" },
  up
}
