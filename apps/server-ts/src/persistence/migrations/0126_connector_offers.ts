import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/**
 * A permission offer may name a connector (`change_json` kind `connector`):
 * "Use GitHub without asking?" saves one rule for every tool of that MCP
 * server, in the Space's list or the global list.
 *
 * Cheap: one row per offer Arden showed, a few dozen at most. The table is
 * renamed aside with legacy ALTER TABLE, so the triggers and the child
 * tables' REFERENCES that name `permission_offers` keep naming the new table.
 */
const permissionOffers = `CREATE TABLE permission_offers (
      question_id TEXT PRIMARY KEY CHECK(length(question_id) > 0),
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      tool_name TEXT CHECK(tool_name IS NULL OR length(tool_name) BETWEEN 1 AND 256),
      server_name TEXT CHECK(server_name IS NULL OR length(server_name) > 0),
      change_json TEXT NOT NULL CHECK(json_valid(change_json)
        AND json_extract(change_json, '$.kind') IN ('tool', 'connector', 'mode', 'command')),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('message', 'approvals')),
      source_message_id TEXT,
      choices_json TEXT NOT NULL CHECK(json_valid(choices_json) AND json_type(choices_json) = 'array'),
      decision TEXT CHECK(decision IS NULL OR decision IN ('chat', 'desk', 'automation', 'everywhere', 'no')),
      created_at TEXT NOT NULL,
      settled_at TEXT,
      CHECK((json_extract(change_json, '$.kind') = 'tool') = (tool_name IS NOT NULL)),
      CHECK(json_extract(change_json, '$.kind') != 'connector' OR server_name IS NOT NULL),
      CHECK((source_kind = 'message') = (source_message_id IS NOT NULL)),
      CHECK((decision IS NULL) = (settled_at IS NULL))
    )`

const up = (database: DatabaseSync): void => {
  database.exec("PRAGMA legacy_alter_table = ON")
  try {
    database.exec("ALTER TABLE permission_offers RENAME TO permission_offers_prior")
  } finally {
    database.exec("PRAGMA legacy_alter_table = OFF")
  }
  database.exec(permissionOffers)
  database.exec(`INSERT INTO permission_offers (
      question_id, session_id, tool_name, server_name, change_json, source_kind,
      source_message_id, choices_json, decision, created_at, settled_at
    ) SELECT question_id, session_id, tool_name, server_name, change_json, source_kind,
      source_message_id, choices_json, decision, created_at, settled_at
    FROM permission_offers_prior`)
  database.exec("DROP TABLE permission_offers_prior")
  database.exec(`CREATE INDEX idx_permission_offers_session_tool
      ON permission_offers(session_id, tool_name)`)
}

export const connectorOffers: Migration = {
  version: 126,
  name: "connector_offers",
  foreignKeys: { kind: "rebuilds", tables: ["permission_offers"] },
  up
}
