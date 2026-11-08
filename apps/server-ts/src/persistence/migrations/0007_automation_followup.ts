import type { Migration } from "./index.js"

export const automationFollowup: Migration = {
  version: 7,
  name: "automation_followup",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(
      "ALTER TABLE scheduled_tasks ADD COLUMN followup_generation INTEGER NOT NULL DEFAULT 0"
    )
    database.exec(
      "ALTER TABLE automation_runs ADD COLUMN followup_json TEXT CHECK(followup_json IS NULL OR json_valid(followup_json))"
    )
  }
}
