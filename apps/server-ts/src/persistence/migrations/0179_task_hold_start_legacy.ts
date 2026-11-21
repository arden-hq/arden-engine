import type { Migration } from "./index.js"

/**
 * A Task's queue row that a worker held across migration 178 gets back the hold start
 * its Task's old job definition stored (`scheduled_tasks.job_held_since`). The next
 * claim of that row overwrites the old value, so it is read here, before any work.
 *
 * Only a stored start is carried. The row must be held, name one Task that exists,
 * name the running attempt of that Task, and be the only held row of that Task; the
 * stored start must not be later than the row's last heartbeat. Any other row keeps
 * NULL: its start is not known, and neither `claimed_at` nor the attempt's start says it.
 *
 * Writes `hold_started_at` and nothing else. At most one row per held Task matches,
 * so this is a migration and not a backfill.
 */
export const taskHoldStartLegacy: Migration = {
  version: 179,
  name: "task_hold_start_legacy",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(`UPDATE automation_event_queue AS queue
      SET hold_started_at = (
        SELECT legacy.job_held_since FROM scheduled_tasks AS legacy
        WHERE legacy.task_id = queue.task_id AND legacy.purpose = 'task_execution'
      )
      WHERE queue.claimed_at IS NOT NULL
        AND queue.hold_started_at IS NULL
        AND substr(queue.task_id, 1, 5) = 'task:'
        AND EXISTS (
          SELECT 1 FROM space_tasks AS item WHERE item.item_id = substr(queue.task_id, 6)
        )
        AND EXISTS (
          SELECT 1 FROM scheduled_tasks AS legacy
          WHERE legacy.task_id = queue.task_id
            AND legacy.purpose = 'task_execution'
            AND legacy.owner_task_id = substr(queue.task_id, 6)
            AND legacy.job_held_since IS NOT NULL
            AND legacy.job_held_since <= queue.claimed_at
        )
        AND EXISTS (
          SELECT 1 FROM automation_runs AS attempt
          WHERE attempt.id = json_extract(queue.context, '$.automation_run_id')
            AND attempt.task_id = queue.task_id
            AND attempt.item_id = substr(queue.task_id, 6)
            AND attempt.status = 'running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM automation_event_queue AS other
          WHERE other.task_id = queue.task_id
            AND other.id != queue.id
            AND other.claimed_at IS NOT NULL
        )`)
}
