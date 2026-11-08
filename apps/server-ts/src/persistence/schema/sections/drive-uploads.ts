import type { OperationalSchemaSection } from "../section.js"

export const driveUploadsSchemaSection = {
  name: "google.drive_uploads",
  storageDomain: "operations",
  tables: ["drive_uploads"],
  indexes: [],
  triggers: [],
  statements: [
    `CREATE TABLE drive_uploads (
      session_id TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      remote_file_id TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
      status TEXT NOT NULL CHECK(status IN ('reserved','confirmed')),
      PRIMARY KEY(session_id,account_ref,operation_key)
    )`
  ]
} as const satisfies OperationalSchemaSection
