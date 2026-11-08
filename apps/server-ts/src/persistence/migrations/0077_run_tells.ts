import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE run_tells (
      run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
      n INTEGER NOT NULL CHECK(n >= 1),
      tool_call_id TEXT NOT NULL,
      text TEXT NOT NULL,
      place TEXT,
      place_kind TEXT NOT NULL CHECK(place_kind IN ('chat', 'parent')),
      occurred_at TEXT NOT NULL,
      shown INTEGER NOT NULL CHECK(shown IN (0, 1)),
      delivery_error TEXT,
      PRIMARY KEY (run_id, n),
      UNIQUE (run_id, tool_call_id)
    )`)
}

export const runTells: Migration = {
  version: 77,
  name: "run_tells",
  foreignKeys: { kind: "enforced" },
  up
}
