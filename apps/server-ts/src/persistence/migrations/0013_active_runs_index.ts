import type { Migration } from "./index.js"

/**
 * Indexes the Runs that still own their Session (`ACTIVE_RUN_STATUSES`).
 * Queries filter on exactly that set every second (revoked Task attempts) and
 * on every boot, and the recovery index (which adds `interrupted`) cannot
 * serve them: SQLite uses a partial index only when the query repeats its
 * WHERE. Without this one each poll read the whole `chat_runs` table, half a
 * second cold on a long-used database.
 */
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
