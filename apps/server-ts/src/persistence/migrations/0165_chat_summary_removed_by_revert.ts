import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** A revert removes the chat summary it cuts into, instead of cutting its position back.
 *
 * A summary is derived from the messages it covers, so once a removed message is among them its
 * title, text and topics are stale; the next summary run writes a fresh one from what is left. */
const up = (database: DatabaseSync): void => {
  database.exec("DROP TRIGGER chat_positions_cut_at_removal")
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
        DELETE FROM chat_summaries
        WHERE session_id = OLD.session_id AND through_sequence >= OLD.seq;
      END`)
}

export const chatSummaryRemovedByRevert: Migration = {
  version: 165,
  name: "chat_summary_removed_by_revert",
  foreignKeys: { kind: "enforced" },
  up
}
