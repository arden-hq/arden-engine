import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const commandPermissions = `CREATE TABLE command_permissions (
      permission_id TEXT PRIMARY KEY CHECK(length(permission_id) > 0),
      executable_path TEXT NOT NULL CHECK(length(executable_path) > 0),
      argument_prefix_json TEXT NOT NULL CHECK(json_valid(argument_prefix_json) AND json_type(argument_prefix_json) = 'array'),
      display_prefix TEXT NOT NULL CHECK(length(display_prefix) BETWEEN 1 AND 512),
      granted_at TEXT,
      UNIQUE (executable_path, argument_prefix_json)
    )`

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE command_permissions RENAME TO command_permissions_prior")
  database.exec(commandPermissions)
  database.exec(`INSERT INTO command_permissions (
      permission_id, executable_path, argument_prefix_json, display_prefix, granted_at
    )
    SELECT lower(hex(randomblob(16))), executable_path, argument_prefix_json, display_prefix, NULL
    FROM command_permissions_prior`)
  database.exec("DROP TABLE command_permissions_prior")
}

export const commandPermissionIdentity: Migration = {
  version: 3,
  name: "command_permission_identity",
  up
}
