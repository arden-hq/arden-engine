import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE trace_trim_due (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('agent', 'fork')),
      run_id TEXT NOT NULL,
      ended_at TEXT NOT NULL
    ) WITHOUT ROWID`)
  database.exec(`CREATE INDEX idx_trace_trim_due_kind_ended ON trace_trim_due(kind, ended_at)`)
  database.exec(`INSERT INTO trace_trim_due(session_id, kind, run_id, ended_at)
      SELECT s.session_id, CASE
          WHEN s.session_type = 'agent' THEN 'agent'
          WHEN s.session_type = 'chat' AND s.parent_session_id IS NOT NULL
            AND s.origin_automation_id IS NOT NULL
            AND COALESCE(json_type(s.metadata, '$.fork_origin'), json_type(s.metadata, '$.fork_of')) IS NOT NULL
            THEN 'fork'
        END, run.run_id, run.ended_at
      FROM sessions AS s
      JOIN chat_runs AS run ON run.run_id = (
        SELECT candidate.run_id FROM chat_runs AS candidate
        WHERE candidate.session_id = s.session_id
        ORDER BY candidate.updated_at DESC, candidate.started_at DESC, candidate.run_id DESC
        LIMIT 1)
      WHERE run.ended_at IS NOT NULL
        AND CASE
          WHEN s.session_type = 'agent' THEN 'agent'
          WHEN s.session_type = 'chat' AND s.parent_session_id IS NOT NULL
            AND s.origin_automation_id IS NOT NULL
            AND COALESCE(json_type(s.metadata, '$.fork_origin'), json_type(s.metadata, '$.fork_of')) IS NOT NULL
            THEN 'fork'
        END IS NOT NULL
        AND COALESCE(json_extract(s.metadata, '$.agent_trace_retained_run_id'), '') <> run.run_id`)
  database.exec(`CREATE TRIGGER trace_trim_due_run_ai
      AFTER INSERT ON chat_runs BEGIN
        DELETE FROM trace_trim_due WHERE session_id = new.session_id;
        INSERT INTO trace_trim_due(session_id, kind, run_id, ended_at)
          SELECT s.session_id, CASE
          WHEN s.session_type = 'agent' THEN 'agent'
          WHEN s.session_type = 'chat' AND s.parent_session_id IS NOT NULL
            AND s.origin_automation_id IS NOT NULL
            AND COALESCE(json_type(s.metadata, '$.fork_origin'), json_type(s.metadata, '$.fork_of')) IS NOT NULL
            THEN 'fork'
        END, new.run_id, new.ended_at
          FROM sessions AS s
          WHERE s.session_id = new.session_id AND new.ended_at IS NOT NULL
            AND CASE
          WHEN s.session_type = 'agent' THEN 'agent'
          WHEN s.session_type = 'chat' AND s.parent_session_id IS NOT NULL
            AND s.origin_automation_id IS NOT NULL
            AND COALESCE(json_type(s.metadata, '$.fork_origin'), json_type(s.metadata, '$.fork_of')) IS NOT NULL
            THEN 'fork'
        END IS NOT NULL
            AND COALESCE(json_extract(s.metadata, '$.agent_trace_retained_run_id'), '') <> new.run_id;
      END`)
  database.exec(`CREATE TRIGGER trace_trim_due_run_au
      AFTER UPDATE OF ended_at ON chat_runs WHEN old.ended_at IS NOT new.ended_at BEGIN
        DELETE FROM trace_trim_due WHERE session_id = new.session_id;
        INSERT INTO trace_trim_due(session_id, kind, run_id, ended_at)
          SELECT s.session_id, CASE
          WHEN s.session_type = 'agent' THEN 'agent'
          WHEN s.session_type = 'chat' AND s.parent_session_id IS NOT NULL
            AND s.origin_automation_id IS NOT NULL
            AND COALESCE(json_type(s.metadata, '$.fork_origin'), json_type(s.metadata, '$.fork_of')) IS NOT NULL
            THEN 'fork'
        END, new.run_id, new.ended_at
          FROM sessions AS s
          WHERE s.session_id = new.session_id AND new.ended_at IS NOT NULL
            AND CASE
          WHEN s.session_type = 'agent' THEN 'agent'
          WHEN s.session_type = 'chat' AND s.parent_session_id IS NOT NULL
            AND s.origin_automation_id IS NOT NULL
            AND COALESCE(json_type(s.metadata, '$.fork_origin'), json_type(s.metadata, '$.fork_of')) IS NOT NULL
            THEN 'fork'
        END IS NOT NULL
            AND COALESCE(json_extract(s.metadata, '$.agent_trace_retained_run_id'), '') <> new.run_id;
      END`)
}

export const traceTrimDue: Migration = {
  version: 148,
  name: "trace_trim_due",
  foreignKeys: { kind: "enforced" },
  up
}
