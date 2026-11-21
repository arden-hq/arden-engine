import type { Migration } from "./index.js"

export const taskHoldStartedAt: Migration = {
  version: 178,
  name: "task_hold_started_at",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(`ALTER TABLE automation_event_queue ADD COLUMN hold_started_at TEXT
      CHECK(hold_started_at IS NULL OR claimed_at IS NOT NULL)`)
}
