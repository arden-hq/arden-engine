import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** When Capture last gave up on a backlog range; it rests a day from then. */
const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE memory_capture_backlog ADD COLUMN tried_at TEXT")
}

export const captureBacklogTriedAt: Migration = {
  version: 164,
  name: "capture_backlog_tried_at",
  foreignKeys: { kind: "enforced" },
  up
}
