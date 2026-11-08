import type { Migration } from "./index.js"

export const queuedFailure: Migration = {
  version: 137,
  name: "queued_failure",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(
      "ALTER TABLE session_queued_messages ADD COLUMN failed_reason TEXT CHECK(failed_reason IS NULL OR length(failed_reason) > 0)"
    )
    database.exec("ALTER TABLE session_queued_messages ADD COLUMN failed_at TEXT")
  }
}
