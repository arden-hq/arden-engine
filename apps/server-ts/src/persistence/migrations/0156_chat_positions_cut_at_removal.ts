import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** A removed message cuts every position kept in its chat back to before it, because new messages
 * then reuse its number: Memory Capture's position and old backlog ranges, and the chat summary.
 *
 * A prepared Capture batch that read past the removed message keeps what it read before it and
 * records the first message removed in `prepared_cut_seq`: a finished batch advances to the
 * message before that, and a batch resumed after a restart reads only up to it. A removal at or
 * before the batch's first message clears the batch, since nothing it read is left. A batch
 * starts at the position: inside message `read_seq` when an offset is kept, else after it.
 *
 * A chat summary that reaches the removed message is deleted, as is every stored summary that
 * already reaches past its chat's last message. */
const up = (database: DatabaseSync): void => {
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
