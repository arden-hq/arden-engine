import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const PERMISSION_OFFERS = `CREATE TABLE permission_offers (
      question_id TEXT PRIMARY KEY CHECK(length(question_id) > 0),
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 256),
      server_name TEXT CHECK(server_name IS NULL OR length(server_name) > 0),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('message', 'approvals')),
      source_message_id TEXT,
      choices_json TEXT NOT NULL CHECK(json_valid(choices_json) AND json_type(choices_json) = 'array'),
      decision TEXT CHECK(decision IS NULL OR decision IN ('chat', 'desk', 'automation', 'everywhere', 'no')),
      created_at TEXT NOT NULL,
      settled_at TEXT,
      CHECK((source_kind = 'message') = (source_message_id IS NOT NULL)),
      CHECK((decision IS NULL) = (settled_at IS NULL))
    )`

const PERMISSION_OFFERS_INDEX = `CREATE INDEX idx_permission_offers_session_tool
      ON permission_offers(session_id, tool_name)`

const STANDING_PERMISSIONS = `CREATE TABLE standing_permissions (
      permission_id TEXT PRIMARY KEY CHECK(length(permission_id) > 0),
      principal TEXT NOT NULL CHECK(
        principal LIKE 'desk:%' OR principal LIKE 'automation:%' OR principal LIKE 'chat:%'
      ),
      server_name TEXT REFERENCES mcp_servers(name) ON DELETE CASCADE,
      tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 256),
      granted_at TEXT NOT NULL,
      source_question_id TEXT REFERENCES permission_offers(question_id) ON DELETE SET NULL
    )`

const STANDING_PERMISSIONS_INDEXES = [
  `CREATE UNIQUE INDEX idx_standing_permissions_identity
      ON standing_permissions(principal, tool_name)`,
  `CREATE INDEX idx_standing_permissions_server
      ON standing_permissions(server_name, granted_at DESC)`
] as const

const up = (database: DatabaseSync): void => {
  database.exec(PERMISSION_OFFERS)
  database.exec(PERMISSION_OFFERS_INDEX)
  database.exec("ALTER TABLE standing_permissions RENAME TO standing_permissions_prior")
  database.exec(STANDING_PERMISSIONS)
  database.exec(`INSERT INTO standing_permissions (
      permission_id, principal, server_name, tool_name, granted_at, source_question_id
    )
    SELECT permission_id, principal, server_name, tool_name, granted_at, NULL
    FROM standing_permissions_prior`)
  database.exec("DROP TABLE standing_permissions_prior")
  for (const statement of STANDING_PERMISSIONS_INDEXES) database.exec(statement)
}

export const chatPermissionGrants: Migration = {
  version: 51,
  name: "chat_permission_grants",
  foreignKeys: { kind: "rebuilds", tables: ["standing_permissions"] },
  up
}
