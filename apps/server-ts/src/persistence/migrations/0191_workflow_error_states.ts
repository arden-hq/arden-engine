import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE code_mode_scripts SET error_json = json_remove(json_set(error_json,
      '$.recovery', CASE WHEN json_type(error_json, '$.recovery_action') = 'text'
        THEN json_object('kind', 'action', 'text', json_extract(error_json, '$.recovery_action'))
        ELSE json_object('kind', 'none') END,
      '$.preview', CASE WHEN json_type(error_json, '$.preview') = 'text'
        THEN json_object('kind', 'line', 'text', json_extract(error_json, '$.preview'))
        ELSE json_object('kind', 'message') END),
    '$.recovery_action')
    WHERE error_json IS NOT NULL AND json_valid(error_json)
      AND json_type(error_json, '$.recovery') IS NULL`)
}

export const workflowErrorStates: Migration = {
  version: 191,
  name: "workflow_error_states",
  foreignKeys: { kind: "enforced" },
  up
}
