import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const toolCallTargets = `CREATE TABLE tool_call_targets (
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK(length(source) > 0),
      object_id TEXT NOT NULL CHECK(length(object_id) > 0),
      at TEXT NOT NULL,
      title TEXT,
      href TEXT,
      origin TEXT NOT NULL DEFAULT 'named' CHECK(origin IN ('named', 'created')),
      PRIMARY KEY (run_id, tool_call_id, source, object_id),
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE tool_call_targets RENAME TO tool_call_targets_prior")
  database.exec(toolCallTargets)
  database.exec(`INSERT INTO tool_call_targets
      (run_id, tool_call_id, source, object_id, at, title, href, origin)
    SELECT run_id, tool_call_id, source, object_id, at, title, href, origin
    FROM tool_call_targets_prior`)
  database.exec("DROP TABLE tool_call_targets_prior")
  database.exec(
    "CREATE INDEX idx_tool_call_targets_object ON tool_call_targets(source, object_id, at)"
  )
}

export const manyCallTargets: Migration = {
  version: 92,
  name: "many_call_targets",
  foreignKeys: { kind: "rebuilds", tables: ["tool_call_targets"] },
  up
}
