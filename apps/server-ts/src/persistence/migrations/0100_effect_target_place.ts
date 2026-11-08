import type { Migration } from "./index.js"

export const effectTargetPlace: Migration = {
  version: 100,
  name: "effect_target_place",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("ALTER TABLE tool_call_targets ADD COLUMN place TEXT")
  }
}
