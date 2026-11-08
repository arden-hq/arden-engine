import type { Migration } from "./index.js"

const DEFERRED_TOOL_CALLS_TABLE = `CREATE TABLE deferred_tool_calls (
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      session_id TEXT NOT NULL CHECK(length(session_id) > 0),
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      tool_name TEXT NOT NULL CHECK(length(tool_name) > 0),
      action TEXT NOT NULL CHECK(length(action) > 0),
      scope TEXT NOT NULL CHECK(length(scope) > 0),
      preview TEXT,
      diff TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
      arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json) = 'object'),
      changes_state INTEGER NOT NULL CHECK(changes_state IN (0, 1)),
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'ran')),
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
      PRIMARY KEY (run_id, tool_call_id),
      FOREIGN KEY (run_id, session_id, tool_call_id)
        REFERENCES tool_calls(run_id, session_id, tool_call_id) ON DELETE CASCADE,
      CHECK((status = 'pending') = (resolved_at IS NULL)),
      CHECK((status = 'ran') = (result_json IS NOT NULL))
    )`

const DEFERRED_TOOL_CALLS_INDEX =
  "CREATE INDEX idx_deferred_tool_calls_status ON deferred_tool_calls(status, session_id)"

export const deferredToolCalls: Migration = {
  version: 40,
  name: "deferred_tool_calls",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(DEFERRED_TOOL_CALLS_TABLE)
    database.exec(DEFERRED_TOOL_CALLS_INDEX)
  }
}
