import type { Migration } from "./index.js"

export const runtimeRecordRun: Migration = {
  version: 187,
  name: "runtime_record_run",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(`UPDATE session_messages
      SET message_json = json_set(message_json, '$.arden_context_run_id',
        substr(message_id, 1, instr(message_id, ':context:runtime:') - 1))
      WHERE role = 'developer'
        AND json_valid(message_json)
        AND json_extract(message_json, '$.arden_context_source') = 'runtime'
        AND json_type(message_json, '$.arden_context_run_id') IS NULL
        AND instr(message_id, ':context:runtime:') > 1`)
}
