import type { Migration } from "./index.js"

export const taskContinuationContext: Migration = {
  version: 5,
  name: "task_continuation_context",
  up: (database) => {
    database.exec("ALTER TABLE desk_tasks ADD COLUMN continuation_context TEXT")
  }
}
