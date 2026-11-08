import type { Migration } from "./index.js"

export const dropIterationsUsed: Migration = {
  version: 22,
  name: "drop_iterations_used",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("ALTER TABLE execution_budgets DROP COLUMN iterations_used")
  }
}
