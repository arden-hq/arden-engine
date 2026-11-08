import type { Migration } from "./index.js"

export const dropRunRecoveryIndex: Migration = {
  version: 140,
  name: "drop_run_recovery_index",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("DROP INDEX idx_chat_runs_recovery_status")
  }
}
