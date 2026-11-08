import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE scheduled_tasks SET triggers = (
      SELECT json_group_array(json(CASE WHEN json_type(value, '$.id') IS NULL
        THEN json_set(value, '$.id', 't' || (key + 1)) ELSE value END))
      FROM (SELECT key, value FROM json_each(scheduled_tasks.triggers) ORDER BY key)
    )
    WHERE json_valid(triggers) AND json_array_length(triggers) > 0`)
  database.exec(`UPDATE automation_runs SET skip_json = json_set(skip_json, '$.asked', json('[]'))
    WHERE skip_json IS NOT NULL AND json_extract(skip_json, '$.reason') = 'prefilter'
      AND json_type(skip_json, '$.asked') IS NULL`)
  database.exec(`UPDATE scheduled_tasks SET last_result = (
      SELECT CASE WHEN run.status = 'completed' THEN run.result ELSE run.error END
      FROM automation_runs AS run
      WHERE run.task_id = scheduled_tasks.task_id AND run.skip_json IS NULL
        AND run.ended_at IS NOT NULL AND run.status != 'running'
      ORDER BY run.id DESC LIMIT 1)
    WHERE last_result IN (${SKIP_LINES})`)
  database.exec(`UPDATE scheduled_tasks SET last_run_at = (
      SELECT MAX(run.ended_at) FROM automation_runs AS run
      WHERE run.task_id = scheduled_tasks.task_id AND run.skip_json IS NULL
        AND run.status = 'completed')
    WHERE EXISTS (SELECT 1 FROM automation_runs AS skip
      WHERE skip.task_id = scheduled_tasks.task_id AND skip.skip_json IS NOT NULL
        AND skip.ended_at = scheduled_tasks.last_run_at)`)
}

const SKIP_LINES = [
  "'Run only if said no to this event; no run started.'",
  "'Nothing new to review; no run started.'"
].join(", ")

export const triggerIdsAndSkipRecords: Migration = {
  version: 63,
  name: "trigger_ids_and_skip_records",
  foreignKeys: { kind: "enforced" },
  up
}
