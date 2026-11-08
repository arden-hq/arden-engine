import type { OperationalSchemaSection } from "../section.js"

export const dataBackfillsSchemaSection = {
  name: "data-backfills",
  storageDomain: "operations",
  tables: ["data_backfills"],
  indexes: [],
  triggers: [],
  statements: [
    `CREATE TABLE data_backfills (
      name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 64),
      cursor TEXT,
      converted INTEGER NOT NULL DEFAULT 0 CHECK(converted >= 0),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    )`
  ]
} as const satisfies OperationalSchemaSection
