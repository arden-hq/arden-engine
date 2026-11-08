import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const MESSAGE_TURNS_STATEMENTS = [
  `CREATE TABLE message_turns (
      message_rowid INTEGER PRIMARY KEY,
      turn_id TEXT
    )`,
  "CREATE INDEX idx_message_turns_turn ON message_turns(turn_id) WHERE turn_id IS NOT NULL",
  `CREATE TRIGGER message_turns_ai
      AFTER INSERT ON session_messages BEGIN
        INSERT OR REPLACE INTO message_turns(message_rowid, turn_id) VALUES (
          new.message_rowid,
          CASE WHEN json_valid(new.message_json) THEN json_extract(new.message_json, '$.turn_id') END
        );
      END`,
  `CREATE TRIGGER message_turns_au
      AFTER UPDATE OF message_json ON session_messages BEGIN
        INSERT OR REPLACE INTO message_turns(message_rowid, turn_id) VALUES (
          new.message_rowid,
          CASE WHEN json_valid(new.message_json) THEN json_extract(new.message_json, '$.turn_id') END
        );
      END`,
  `CREATE TRIGGER message_turns_ad
      AFTER DELETE ON session_messages BEGIN
        DELETE FROM message_turns WHERE message_rowid = old.message_rowid;
      END`
] as const

const up = (database: DatabaseSync): void => {
  for (const statement of MESSAGE_TURNS_STATEMENTS) database.exec(statement)
}

export const messageTurnIds: Migration = {
  version: 61,
  name: "message_turn_ids",
  foreignKeys: { kind: "enforced" },
  up
}
