import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(
    "ALTER TABLE scheduled_tasks ADD COLUMN trigger_last_id INTEGER NOT NULL DEFAULT 0 CHECK(trigger_last_id >= 0)"
  )
  database.exec(`UPDATE scheduled_tasks SET trigger_last_id = COALESCE((
      SELECT MAX(CAST(substr(json_extract(value, '$.id'), 2) AS INTEGER))
      FROM json_each(scheduled_tasks.triggers)
      WHERE json_extract(value, '$.id') GLOB 't[1-9]*'
        AND NOT substr(json_extract(value, '$.id'), 2) GLOB '*[^0-9]*'), 0)
    WHERE json_valid(triggers)`)
  database.exec(`UPDATE automation_runs SET skip_json = json_set(skip_json, '$.cancelled', json('null'))
    WHERE skip_json IS NOT NULL AND json_extract(skip_json, '$.reason') = 'prefilter'
      AND json_type(skip_json, '$.cancelled') IS NULL`)
}

export const triggerCounterAndCancelledSkips: Migration = {
  version: 66,
  name: "trigger_counter_and_cancelled_skips",
  foreignKeys: { kind: "enforced" },
  up
}
