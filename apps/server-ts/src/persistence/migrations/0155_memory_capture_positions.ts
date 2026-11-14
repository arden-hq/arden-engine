import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** Memory Capture keeps one position per owner chat: how far it has read.
 *
 * Capture used to mark each finished turn in `run_sidecars` and rebuild a cursor from the
 * marks, keyed by the chat's context number. Compaction, clear, revert and archive change that
 * number or hide the chat, so on the owner's data 966 marks waited and none could be read.
 * Stopped turns were never marked, and a long gap after a context change was read only in part.
 *
 * Capture now reads each owner chat from its position to its last message whenever no run is
 * active in it. Only a removed message moves a position back: the trigger cuts it, and any
 * prepared batch and old range that reach the removed message, because new messages then reuse
 * its number.
 *
 * Every existing owner chat starts at its last message, so nothing old is read after the update.
 * Its old messages become one backlog range, which Capture never reads. A backfill then removes
 * from those ranges what the old marks show Capture read, and the copies a branch holds of its
 * source, and deletes the old marks.
 *
 * A Capture job that prepared its batch before the update stores that batch in the old shape,
 * which no claim can read, so one such job would stop every Automation. Those jobs are deleted.
 * The trigger from migration 0154 closes their runs as interrupted, and their messages are in the
 * backlog with the rest. */
const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE memory_capture_positions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      read_seq INTEGER NOT NULL CHECK(read_seq >= -1),
      read_offset INTEGER CHECK(read_offset IS NULL OR (read_offset > 0 AND read_seq >= 0)),
      prepared_json TEXT CHECK(prepared_json IS NULL OR json_valid(prepared_json)),
      updated_at TEXT NOT NULL
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
  database.exec(`CREATE TRIGGER memory_capture_cut_at_removal
      AFTER DELETE ON session_messages
      WHEN EXISTS (SELECT 1 FROM memory_capture_positions WHERE session_id = OLD.session_id)
      BEGIN
        UPDATE memory_capture_positions
        SET read_seq = OLD.seq - 1, read_offset = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE session_id = OLD.session_id AND read_seq >= OLD.seq;
        UPDATE memory_capture_positions
        SET prepared_json = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE session_id = OLD.session_id AND prepared_json IS NOT NULL
          AND COALESCE(json_extract(prepared_json, '$.end.sequence'),
            json_extract(prepared_json, '$.end.progress.sequence')) >= OLD.seq;
        DELETE FROM memory_capture_backlog
        WHERE session_id = OLD.session_id AND from_seq >= OLD.seq;
        UPDATE memory_capture_backlog SET through_seq = OLD.seq - 1
        WHERE session_id = OLD.session_id AND through_seq >= OLD.seq;
      END`)
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
  database.exec(`DELETE FROM automation_event_queue
      WHERE json_extract(context, '$.handler_item.input.data.kind') = 'memory'`)
}

export const memoryCapturePositions: Migration = {
  version: 155,
  name: "memory_capture_positions",
  foreignKeys: { kind: "enforced" },
  up
}
