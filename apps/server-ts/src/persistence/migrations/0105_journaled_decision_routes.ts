import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE journaled_decision_routes (
      source_kind TEXT NOT NULL CHECK(source_kind IN ('run', 'deferred')),
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      viewer_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      source_session_id TEXT NOT NULL CHECK(length(source_session_id) > 0),
      route_basis TEXT NOT NULL CHECK(length(route_basis) > 0),
      PRIMARY KEY (source_kind, run_id, tool_call_id, viewer_session_id)
    ) WITHOUT ROWID`)
  database.exec(`INSERT INTO journaled_decision_routes (source_kind, run_id, tool_call_id,
      viewer_session_id, source_session_id, route_basis)
    SELECT source_kind, run_id, tool_call_id, viewer_session_id, source_session_id, route_basis
    FROM pending_decision_visibility`)
}

export const journaledDecisionRoutes: Migration = {
  version: 105,
  name: "journaled_decision_routes",
  foreignKeys: { kind: "enforced" },
  up
}
