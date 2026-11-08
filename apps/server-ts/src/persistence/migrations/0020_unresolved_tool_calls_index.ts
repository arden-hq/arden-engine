import type { Migration } from "./index.js"

export const unresolvedToolCallsIndex: Migration = {
  version: 20,
  name: "unresolved_tool_calls_index",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE INDEX idx_tool_calls_session_unresolved
      ON tool_calls(session_id, status)
      WHERE status IN ('running', 'ready', 'paused', 'uncertain')`)
  }
}
