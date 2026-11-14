import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** Every owner chat has a Memory Capture position from the moment it exists.
 *
 * Migration 0155 gave each owner chat a position, and a chat made later had none, so Capture
 * read it from its first message. That is right for a new chat and wrong for a chat that starts
 * with copies: an Automation's working copy that continues as a chat held copies of the owner's
 * earlier turns and the Automation's own output, and Capture read them all again.
 *
 * A new owner chat holds nothing, so a trigger starts it at its beginning. A chat that holds
 * copies when it becomes an owner chat (a branch, a continued Automation copy) is moved past them
 * by `startCaptureAfterCopies`, and a second trigger refuses a chat that becomes an owner chat
 * before its position is past the messages it holds. Owner chats made since 0155 start at their
 * beginning, which is where Capture read them from until now. */
const up = (database: DatabaseSync): void => {
  database.exec(`INSERT INTO memory_capture_positions (session_id, read_seq, read_offset, prepared_json, updated_at)
      SELECT session.session_id, -1, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM sessions AS session
      WHERE session.session_type = 'chat' AND session.origin_automation_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM memory_capture_positions AS position
          WHERE position.session_id = session.session_id)`)
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
}

export const ownerChatStartsCapture: Migration = {
  version: 157,
  name: "owner_chat_starts_capture",
  foreignKeys: { kind: "enforced" },
  up
}
