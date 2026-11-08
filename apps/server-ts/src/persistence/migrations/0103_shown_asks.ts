import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE shown_asks (
      ask_kind TEXT NOT NULL CHECK(ask_kind IN ('question', 'card')),
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      ask_id TEXT NOT NULL CHECK(length(ask_id) > 0),
      viewer_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      route_basis TEXT,
      PRIMARY KEY (ask_kind, run_id, ask_id, viewer_session_id)
    ) WITHOUT ROWID`)
}

export const shownAsks: Migration = {
  version: 103,
  name: "shown_asks",
  foreignKeys: { kind: "enforced" },
  up
}
