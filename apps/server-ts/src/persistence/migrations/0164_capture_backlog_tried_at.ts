import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE memory_capture_unread ADD COLUMN tried_at TEXT")
}

export const captureBacklogTriedAt: Migration = {
  version: 164,
  name: "capture_backlog_tried_at",
  foreignKeys: { kind: "enforced" },
  up
}
