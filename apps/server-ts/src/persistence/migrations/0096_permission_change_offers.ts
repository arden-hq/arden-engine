import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const permissionOffers = `CREATE TABLE permission_offers (
      question_id TEXT PRIMARY KEY CHECK(length(question_id) > 0),
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      tool_name TEXT CHECK(tool_name IS NULL OR length(tool_name) BETWEEN 1 AND 256),
      server_name TEXT CHECK(server_name IS NULL OR length(server_name) > 0),
      change_json TEXT NOT NULL CHECK(json_valid(change_json)
        AND json_extract(change_json, '$.kind') IN ('tool', 'mode', 'command')),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('message', 'approvals')),
      source_message_id TEXT,
      choices_json TEXT NOT NULL CHECK(json_valid(choices_json) AND json_type(choices_json) = 'array'),
      decision TEXT CHECK(decision IS NULL OR decision IN ('chat', 'desk', 'automation', 'everywhere', 'no')),
      created_at TEXT NOT NULL,
      settled_at TEXT,
      CHECK((json_extract(change_json, '$.kind') = 'tool') = (tool_name IS NOT NULL)),
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
    ) SELECT question_id, session_id, tool_name, server_name,
      json_object('kind', 'tool', 'tool', tool_name, 'decision', 'approve'), source_kind,
      source_message_id, choices_json, decision, created_at, settled_at
    FROM permission_offers_prior`)
  database.exec("DROP TABLE permission_offers_prior")
  database.exec(`CREATE INDEX idx_permission_offers_session_tool
      ON permission_offers(session_id, tool_name)`)
}

export const permissionChangeOffers: Migration = {
  version: 96,
  name: "permission_change_offers",
  foreignKeys: { kind: "rebuilds", tables: ["permission_offers"] },
  up
}
