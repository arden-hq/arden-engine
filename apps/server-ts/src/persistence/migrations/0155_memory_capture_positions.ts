import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE memory_capture_positions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      read_seq INTEGER NOT NULL CHECK(read_seq >= -1),
      read_offset INTEGER CHECK(read_offset IS NULL OR (read_offset > 0 AND read_seq >= 0)),
      prepared_json TEXT CHECK(prepared_json IS NULL OR json_valid(prepared_json)),
      updated_at TEXT NOT NULL,
      prepared_cut_seq INTEGER
        CHECK(prepared_cut_seq IS NULL OR (prepared_json IS NOT NULL AND prepared_cut_seq > read_seq))
    ) WITHOUT ROWID`)
  database.exec(`CREATE TABLE memory_capture_backlog (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      from_seq INTEGER NOT NULL CHECK(from_seq >= 0),
      through_seq INTEGER NOT NULL,
      CHECK(through_seq >= from_seq),
      PRIMARY KEY (session_id, from_seq)
    ) WITHOUT ROWID`)
  database.exec(`CREATE INDEX idx_sessions_capture_owner ON sessions(session_id)
      WHERE session_type = 'chat' AND origin_automation_id IS NULL`)
  database.exec(`INSERT INTO memory_capture_positions (session_id, read_seq, read_offset, prepared_json, updated_at)
      SELECT session.session_id,
        COALESCE((SELECT MAX(seq) FROM session_messages WHERE session_id = session.session_id), -1),
        NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM sessions AS session
      WHERE session.session_type = 'chat' AND session.origin_automation_id IS NULL`)
  database.exec(`INSERT INTO memory_capture_backlog (session_id, from_seq, through_seq)
      SELECT session_id, MIN(seq), MAX(seq) FROM session_messages
      WHERE session_id IN (SELECT session_id FROM memory_capture_positions)
      GROUP BY session_id`)
  database.exec(`CREATE TRIGGER memory_capture_owner_chat_starts
      AFTER INSERT ON sessions
      WHEN NEW.session_type = 'chat' AND NEW.origin_automation_id IS NULL
      BEGIN
        INSERT INTO memory_capture_positions (session_id, read_seq, read_offset, prepared_json, updated_at)
        VALUES (NEW.session_id, -1, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      END`)
  database.exec(`CREATE TRIGGER memory_capture_owner_chat_starts_after_copies
      BEFORE UPDATE OF session_type, origin_automation_id ON sessions
      WHEN NEW.session_type = 'chat' AND NEW.origin_automation_id IS NULL
        AND NOT (OLD.session_type = 'chat' AND OLD.origin_automation_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM memory_capture_positions AS position
          WHERE position.session_id = NEW.session_id
            AND position.read_seq >= COALESCE((SELECT MAX(seq) FROM session_messages
              WHERE session_id = NEW.session_id), -1))
      BEGIN
        SELECT RAISE(ABORT, 'A chat becomes an owner chat only once Memory Capture starts after the messages it holds');
      END`)
  database.exec(`DELETE FROM automation_event_queue
      WHERE json_extract(context, '$.handler_item.input.data.kind') = 'memory'`)
}

export const memoryCapturePositions: Migration = {
  version: 155,
  name: "memory_capture_positions",
  foreignKeys: { kind: "enforced" },
  up
}
