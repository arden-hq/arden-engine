import type { Migration } from "./index.js"

export const activeRunsIndex: Migration = {
  version: 13,
  name: "active_runs_index",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE INDEX idx_chat_runs_active
      ON chat_runs(status)
      WHERE status IN ('pending', 'running', 'backgrounded')`)
  }
}
