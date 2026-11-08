import type { Migration } from "./index.js"

export const runFailedToError: Migration = {
  version: 138,
  name: "run_failed_to_error",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("UPDATE chat_runs SET status = 'error' WHERE status = 'failed'")
    database.exec("DROP INDEX idx_chat_runs_active")
    database.exec(`CREATE INDEX idx_chat_runs_active
      ON chat_runs(status)
      WHERE status IN ('pending', 'running')`)
  }
}
