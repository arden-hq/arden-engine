import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

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
