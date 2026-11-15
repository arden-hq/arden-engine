import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** A Memory change no longer wakes a Space review, so a review job no longer subscribes to
 * `wiki.changed`. Rows that subscription already queued would each be claimed once and end with
 * nothing to act on, so the waiting ones are deleted. A Memory change was always queued as its
 * own `event` row and never merged into another row while it waited: a claim folds waiting rows
 * together only as it starts a run, and the folded row then names that run. So a waiting row is
 * either wholly a Memory change or has none. A row a run has claimed or named, and every other
 * job's rows, are left as they are. */
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
