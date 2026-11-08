import type { Migration } from "./index.js"

export const runCompletion: Migration = {
  version: 56,
  name: "run_completion",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("ALTER TABLE chat_runs ADD COLUMN completion_message_id TEXT")
  }
}
