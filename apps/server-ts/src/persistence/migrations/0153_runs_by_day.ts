import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** An Automation's runs by day.
 *
 * A Space's page counts its reviewer's runs today, and read every run the
 * reviewer ever made to do it (3,500 on the owner's database, up to 1.1 s
 * after a restart). The count asks `date(started_at) = date(now)`, which this
 * index answers with the day's runs only. */
const up = (database: DatabaseSync): void => {
  database.exec(
    `CREATE INDEX idx_automation_runs_task_day ON automation_runs(task_id, date(started_at))`
  )
}

export const runsByDay: Migration = {
  version: 153,
  name: "runs_by_day",
  foreignKeys: { kind: "enforced" },
  up
}
