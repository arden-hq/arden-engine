import type { Migration } from "./index.js"

const statements = [
  "ALTER TABLE tool_call_targets ADD COLUMN title TEXT",
  "ALTER TABLE tool_call_targets ADD COLUMN href TEXT",
  "ALTER TABLE tool_call_targets ADD COLUMN origin TEXT NOT NULL DEFAULT 'named' CHECK(origin IN ('named', 'created'))"
]

export const effectTargetLabels: Migration = {
  version: 91,
  name: "effect_target_labels",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    for (const statement of statements) database.exec(statement)
  }
}
