import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TRIGGER chat_positions_cut_at_removal
      AFTER DELETE ON session_messages
      WHEN EXISTS (SELECT 1 FROM memory_capture_unread WHERE session_id = OLD.session_id)
        OR EXISTS (SELECT 1 FROM chat_summaries WHERE session_id = OLD.session_id)
      BEGIN
        DELETE FROM memory_capture_unread
        WHERE session_id = OLD.session_id AND through_seq IS NOT NULL
          AND read_seq + (read_offset IS NULL) >= OLD.seq;
        UPDATE memory_capture_unread SET through_seq = OLD.seq - 1
        WHERE session_id = OLD.session_id AND through_seq >= OLD.seq;
        UPDATE memory_capture_unread
        SET read_seq = OLD.seq - 1, read_offset = NULL, prepared_json = NULL,
          prepared_cut_seq = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE session_id = OLD.session_id AND read_seq >= OLD.seq;
        UPDATE memory_capture_unread
        SET prepared_json = CASE WHEN OLD.seq <= read_seq + (read_offset IS NULL) THEN NULL ELSE prepared_json END,
          prepared_cut_seq = CASE WHEN OLD.seq <= read_seq + (read_offset IS NULL) THEN NULL
            ELSE MIN(COALESCE(prepared_cut_seq, OLD.seq), OLD.seq) END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE session_id = OLD.session_id AND prepared_json IS NOT NULL
          AND COALESCE(json_extract(prepared_json, '$.end.sequence'),
            json_extract(prepared_json, '$.end.progress.sequence')) >= OLD.seq;
        DELETE FROM chat_summaries
        WHERE session_id = OLD.session_id AND through_sequence >= OLD.seq;
      END`)
  database.exec(`DELETE FROM chat_summaries
    WHERE through_sequence > COALESCE((SELECT MAX(seq) FROM session_messages
      WHERE session_messages.session_id = chat_summaries.session_id), -1)`)
}

export const chatPositionsCutAtRemoval: Migration = {
  version: 156,
  name: "chat_positions_cut_at_removal",
  foreignKeys: { kind: "enforced" },
  up
}
