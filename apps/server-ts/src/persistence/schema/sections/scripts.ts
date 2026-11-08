import type { OperationalSchemaSection } from "../section.js"

const codeModeScriptsTableSql = `CREATE TABLE code_mode_scripts (
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
      ended_at TEXT, progress_json TEXT
      CHECK(progress_json IS NULL OR (json_valid(progress_json) AND json_type(progress_json) = 'object')),
      UNIQUE(origin_run_id, origin_tool_call_id),
      CHECK(updated_at >= created_at),
      CHECK((status = 'running') = (ended_at IS NULL))
    )`

const codeModeScriptsIndexSql = `CREATE INDEX idx_code_mode_scripts_origin_session_status
      ON code_mode_scripts(origin_session_ref, status)`

export const scriptSchemaSection = {
  name: "scripts",
  storageDomain: "workflow",
  tables: ["code_mode_scripts"],
  indexes: ["idx_code_mode_scripts_origin_session_status"],
  triggers: [],
  statements: [codeModeScriptsTableSql, codeModeScriptsIndexSql]
} as const satisfies OperationalSchemaSection
