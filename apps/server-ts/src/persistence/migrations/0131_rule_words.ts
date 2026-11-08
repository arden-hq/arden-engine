import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(
    "ALTER TABLE permission_rules ADD COLUMN said TEXT CHECK(said IS NULL OR length(said) BETWEEN 1 AND 2000)"
  )
}

export const ruleWords: Migration = {
  version: 131,
  name: "rule_words",
  foreignKeys: { kind: "enforced" },
  up
}
