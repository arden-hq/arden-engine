import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE tool_call_targets (
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK(length(source) > 0),
      object_id TEXT NOT NULL CHECK(length(object_id) > 0),
      at TEXT NOT NULL,
      PRIMARY KEY (run_id, tool_call_id),
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`)
  database.exec(
    "CREATE INDEX idx_tool_call_targets_object ON tool_call_targets(source, object_id, at)"
  )
  database.exec("DROP TABLE automation_write_receipts")
}

export const toolCallEffectTargets: Migration = {
  version: 67,
  name: "tool_call_effect_targets",
  foreignKeys: { kind: "enforced" },
  up
}
