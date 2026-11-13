import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** Indexes so the Inbox's failures start from the recent ones.
 *
 * The Inbox shows a failure from the last seven days, or an older one whose
 * Task is stuck, unless a later run of its Automation completed. It read every
 * failed ending, every failure event and every failed attempt on record, and
 * the latest completed start of every Automation, about every 15 seconds.
 * Failed attempts and failed endings are now read by start time, stuck Tasks
 * from their own list, and "a counted run completed later" is one lookup in
 * each Automation's counted completed runs, whose condition the query repeats
 * word for word so SQLite can use the partial index. */
const up = (database: DatabaseSync): void => {
  database.exec(`CREATE INDEX idx_automation_runs_status_started
      ON automation_runs(status, julianday(started_at))`)
  database.exec(`CREATE INDEX idx_run_endings_status_at
      ON run_endings(status, decided, julianday(occurred_at))`)
  database.exec(`CREATE INDEX idx_automation_runs_counted_completed
      ON automation_runs(task_id, julianday(started_at))
      WHERE status = 'completed' AND (CASE WHEN outcome IS NULL
        THEN skip_json IS NULL AND disposition IS NOT 'superseded'
        ELSE outcome <> 'superseded' AND outcome NOT GLOB 'skipped:*' END)`)
  // The failed endings by run id, which only the old Inbox read used.
  database.exec("DROP INDEX idx_run_endings_failed")
  database.exec(`CREATE INDEX idx_space_tasks_stuck ON space_tasks(item_id)
      WHERE status = 'open' AND owner = 'worker' AND next_attempt_at IS NULL`)
}

export const failureLists: Migration = {
  version: 151,
  name: "failure_lists",
  foreignKeys: { kind: "enforced" },
  up
}
