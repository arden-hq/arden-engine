import type { Migration } from "./index.js"

export const automationFailureStreak: Migration = {
  version: 166,
  name: "automation_failure_streak",
  up: (database) =>
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN failed_runs INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scheduled_tasks ADD COLUMN failed_item TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN failed_attempt INTEGER;`)
}
