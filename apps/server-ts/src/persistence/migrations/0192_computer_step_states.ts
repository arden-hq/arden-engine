import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const step = (column: string, path: string): string =>
  `json_set(${column},
      '${path}.app', CASE WHEN json_type(${column}, '${path}.app') = 'object'
        THEN json_set(json_extract(${column}, '${path}.app'), '$.kind', 'identified')
        ELSE json_object('kind', 'unidentified') END,
      '${path}.window', CASE WHEN json_type(${column}, '${path}.window') = 'text'
        THEN json_object('kind', 'titled', 'title', json_extract(${column}, '${path}.window'))
        ELSE json_object('kind', 'untitled') END)`

const legacy = (column: string, path: string): string =>
  `json_valid(${column}) AND json_type(${column}, '${path}') = 'object'
    AND json_type(${column}, '${path}.app.kind') IS NULL`

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE tool_calls SET result_json = ${step("result_json", "$.data.computer")}
    WHERE result_json IS NOT NULL AND ${legacy("result_json", "$.data.computer")}`)
  const journal = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'journal_records'"
    )
    .get()
  if (journal === undefined) return
  database.exec(`UPDATE journal_records SET data_json = ${step("data_json", "$.data.computer")}
    WHERE event_type = 'TOOL_CALL_RESULT' AND ${legacy("data_json", "$.data.computer")}`)
}

export const computerStepStates: Migration = {
  version: 192,
  name: "computer_step_states",
  foreignKeys: { kind: "enforced" },
  up
}
