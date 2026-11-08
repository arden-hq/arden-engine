import type { Migration } from "./index.js"

export const sessionForkOrigin: Migration = {
  version: 80,
  name: "session_fork_origin",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE session_fork_requests (
      request_id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('preparing', 'ready'))
    )`)
    database.exec(
      "CREATE INDEX idx_session_fork_requests_preparing_source ON session_fork_requests(source_session_id) WHERE state = 'preparing'"
    )
    database.exec(`CREATE INDEX idx_sessions_fork_origin_backfill ON sessions(session_id)
      WHERE CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.fork_of') = 'object'
        AND json_type(metadata, '$.fork_of.source_session_id') = 'text'
        AND length(json_extract(metadata, '$.fork_of.source_session_id')) > 0
        AND json_type(metadata, '$.fork_of.through_sequence') = 'integer'
        AND CAST(json_extract(metadata, '$.fork_of.through_sequence') AS INTEGER) >= -1
        ELSE 0 END`)
  }
}
