import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/**
 * The dollars providers reported for a day's calls (`RunUsage.cost`). NULL is
 * unknown: some call counted reported no cost. Rows from before are NULL, as
 * no cost was kept for them.
 */
const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE usage_daily ADD COLUMN cost REAL CHECK(cost IS NULL OR cost >= 0)")
}

export const usageDailyCost: Migration = {
  version: 169,
  name: "usage_daily_cost",
  foreignKeys: { kind: "enforced" },
  up
}
