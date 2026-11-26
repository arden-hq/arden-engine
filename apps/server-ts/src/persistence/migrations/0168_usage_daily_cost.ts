import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE usage_daily ADD COLUMN cost REAL CHECK(cost IS NULL OR cost >= 0)")
}

export const usageDailyCost: Migration = {
  version: 168,
  name: "usage_daily_cost",
  foreignKeys: { kind: "enforced" },
  up
}
