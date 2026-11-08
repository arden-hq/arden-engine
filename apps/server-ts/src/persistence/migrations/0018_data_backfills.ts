import type { Migration } from "./index.js"

export const dataBackfills: Migration = {
  version: 18,
  name: "data_backfills",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE data_backfills (
      name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 64),
      cursor TEXT,
      converted INTEGER NOT NULL DEFAULT 0 CHECK(converted >= 0),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    )`)
  }
}
