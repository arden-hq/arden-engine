import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE scheduled_tasks ADD COLUMN paused_at TEXT")
}

export const automationPausedAt: Migration = {
  version: 104,
  name: "automation_paused_at",
  foreignKeys: { kind: "enforced" },
  up
}
