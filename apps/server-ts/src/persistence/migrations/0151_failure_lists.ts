import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

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
