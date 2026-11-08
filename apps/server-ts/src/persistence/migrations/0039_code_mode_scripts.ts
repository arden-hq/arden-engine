import type { Migration } from "./index.js"

const LIVE = "('queued', 'running', 'needs_input', 'cancelling')"

export const codeModeScripts: Migration = {
  version: 39,
  name: "code_mode_scripts",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE code_mode_scripts (
      script_ref TEXT PRIMARY KEY CHECK(length(script_ref) BETWEEN 1 AND 512),
      origin_session_ref TEXT NOT NULL
        REFERENCES sessions(public_ref) ON DELETE CASCADE
        CHECK(length(origin_session_ref) BETWEEN 1 AND 512),
      origin_run_id TEXT NOT NULL CHECK(length(origin_run_id) BETWEEN 1 AND 512),
      origin_tool_call_id TEXT NOT NULL CHECK(length(origin_tool_call_id) BETWEEN 1 AND 512),
      profile_hash TEXT NOT NULL CHECK(length(profile_hash) BETWEEN 1 AND 512),
      status TEXT NOT NULL CHECK(status IN (
        'running', 'succeeded', 'failed', 'cancelled', 'needs_attention'
      )),
      version INTEGER NOT NULL CHECK(version >= 1),
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      auto_retries INTEGER NOT NULL DEFAULT 0 CHECK(auto_retries >= 0),
      error_json TEXT CHECK(error_json IS NULL OR (json_valid(error_json) AND json_type(error_json) = 'object')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE(origin_run_id, origin_tool_call_id),
      CHECK(updated_at >= created_at),
      CHECK((status = 'running') = (ended_at IS NULL))
    )`)
    database.exec(`CREATE INDEX idx_code_mode_scripts_origin_session_status
      ON code_mode_scripts(origin_session_ref, status)`)
    database.exec(`INSERT INTO code_mode_scripts (
        script_ref, origin_session_ref, origin_run_id, origin_tool_call_id, profile_hash,
        status, version, attempt, auto_retries, error_json, created_at, updated_at, ended_at
      )
      SELECT w.workflow_ref, w.origin_session_ref, w.origin_run_id, w.origin_tool_call_id,
        COALESCE(NULLIF(json_extract(w.definition_json, '$.execution_profile_hash'), ''), 'unknown'),
        CASE WHEN w.status IN ${LIVE} THEN 'running' ELSE w.status END,
        w.version, w.current_attempt, 0,
        CASE WHEN w.status IN ${LIVE} THEN NULL ELSE (
          SELECT a.error_json FROM workflow_attempts AS a
          WHERE a.workflow_ref = w.workflow_ref AND a.attempt = w.current_attempt
        ) END,
        w.created_at, w.updated_at,
        CASE WHEN w.status IN ${LIVE} THEN NULL ELSE COALESCE(w.ended_at, w.updated_at) END
      FROM workflows AS w`)
    database.exec("DROP TABLE workflow_operations")
    database.exec("DROP TABLE workflow_node_attempts")
    database.exec("DROP TABLE workflow_nodes")
    database.exec("DROP TABLE workflow_attempts")
    database.exec("DROP TABLE workflows")
  }
}
