import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** A revert cuts the chat summary's position, as it cuts Memory Capture's.
 *
 * A summary is saved only when it reaches at least as far as the stored one, but a revert lets
 * later messages reuse the removed numbers. A stored summary could then be ahead of its chat, and
 * every newer summary of that chat was refused. The removal trigger now cuts the summary back to
 * the message before the first one removed, and deletes it when no message before that is left.
 * Stored summaries ahead of their chat are cut back to its last message, or deleted when the chat
 * has none. */
const up = (database: DatabaseSync): void => {
  database.exec("DROP TRIGGER memory_capture_cut_at_removal")
  database.exec(`CREATE TRIGGER chat_positions_cut_at_removal
      AFTER DELETE ON session_messages
      WHEN EXISTS (SELECT 1 FROM memory_capture_positions WHERE session_id = OLD.session_id)
        OR EXISTS (SELECT 1 FROM chat_summaries WHERE session_id = OLD.session_id)
      BEGIN
        UPDATE memory_capture_positions
        SET read_seq = OLD.seq - 1, read_offset = NULL, prepared_json = NULL,
          prepared_cut_seq = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE session_id = OLD.session_id AND read_seq >= OLD.seq;
        UPDATE memory_capture_positions
        SET prepared_json = CASE WHEN OLD.seq <= read_seq + (read_offset IS NULL) THEN NULL ELSE prepared_json END,
          prepared_cut_seq = CASE WHEN OLD.seq <= read_seq + (read_offset IS NULL) THEN NULL
            ELSE MIN(COALESCE(prepared_cut_seq, OLD.seq), OLD.seq) END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE session_id = OLD.session_id AND prepared_json IS NOT NULL
          AND COALESCE(json_extract(prepared_json, '$.end.sequence'),
            json_extract(prepared_json, '$.end.progress.sequence')) >= OLD.seq;
        DELETE FROM memory_capture_backlog
        WHERE session_id = OLD.session_id AND from_seq >= OLD.seq;
        UPDATE memory_capture_backlog SET through_seq = OLD.seq - 1
        WHERE session_id = OLD.session_id AND through_seq >= OLD.seq;
        DELETE FROM chat_summaries WHERE session_id = OLD.session_id
          AND NOT EXISTS (SELECT 1 FROM session_messages
            WHERE session_id = OLD.session_id AND seq < OLD.seq);
        UPDATE chat_summaries SET through_sequence = OLD.seq - 1
        WHERE session_id = OLD.session_id AND through_sequence >= OLD.seq;
      END`)
  database.exec(`DELETE FROM chat_summaries
    WHERE NOT EXISTS (SELECT 1 FROM session_messages
      WHERE session_messages.session_id = chat_summaries.session_id)`)
  database.exec(`UPDATE chat_summaries
    SET through_sequence = (SELECT MAX(seq) FROM session_messages
      WHERE session_messages.session_id = chat_summaries.session_id)
    WHERE through_sequence > (SELECT MAX(seq) FROM session_messages
      WHERE session_messages.session_id = chat_summaries.session_id)`)
}

export const chatSummaryCutByRevert: Migration = {
  version: 164,
  name: "chat_summary_cut_by_revert",
  foreignKeys: { kind: "enforced" },
  up
}
