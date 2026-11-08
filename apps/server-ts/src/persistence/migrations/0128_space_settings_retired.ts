import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE permission_settings (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      default_mode TEXT NOT NULL DEFAULT 'safe'
        CHECK(default_mode IN ('read_only', 'ask', 'safe', 'allow'))
    )`)
  database.exec("INSERT INTO permission_settings (singleton_id) VALUES (1)")
  database.exec(`UPDATE desks
    SET inference_policy = json_set(inference_policy, '$.enabled', json('true'))
    WHERE json_extract(inference_policy, '$.enabled') IS NOT 1`)
  database.exec(`UPDATE sessions SET metadata = json_remove(metadata, '$.approval_mode')
    WHERE json_type(metadata, '$.approval_mode') IS NOT NULL
      AND origin_automation_id IN (SELECT task_id FROM scheduled_tasks
        WHERE purpose != 'user_automation' AND owner_desk_id IS NOT NULL)`)
}

export const spaceSettingsRetired: Migration = {
  version: 128,
  name: "space_settings_retired",
  foreignKeys: { kind: "enforced" },
  up
}
