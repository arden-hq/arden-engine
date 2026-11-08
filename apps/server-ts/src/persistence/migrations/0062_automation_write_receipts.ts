import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE automation_write_receipts (
      source TEXT NOT NULL,
      object_id TEXT NOT NULL,
      version TEXT NOT NULL,
      produced_by TEXT NOT NULL,
      chain_depth INTEGER NOT NULL CHECK(chain_depth >= 1),
      written_at TEXT NOT NULL,
      PRIMARY KEY (source, object_id, version)
    )`)
  database.exec(
    "CREATE INDEX idx_automation_write_receipts_written_at ON automation_write_receipts(written_at)"
  )
}

export const automationWriteReceipts: Migration = {
  version: 62,
  name: "automation_write_receipts",
  foreignKeys: { kind: "enforced" },
  up
}
