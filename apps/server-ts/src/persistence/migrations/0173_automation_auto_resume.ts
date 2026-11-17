import type { Migration } from "./index.js"

/** When a user Automation paused by its provider is tried again, and how many tries it has had. */
export const automationAutoResume: Migration = {
  version: 173,
  name: "automation_auto_resume",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN auto_resume_at TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN auto_resumes INTEGER NOT NULL DEFAULT 0;`)
}
