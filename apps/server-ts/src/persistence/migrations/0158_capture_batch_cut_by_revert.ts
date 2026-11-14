import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** A revert inside a Capture batch that is running keeps what the batch read before it.
 *
 * Removing a message a prepared batch read cleared the batch. The run still finished and filed
 * its evidence, but its advance was refused as superseded, so the position stayed at the batch's
 * start and the next batch handed the model the same earlier turns again: one more paid run, and
 * the evidence filed twice.
 *
 * Now the trigger keeps the batch and records the first message removed from it in
 * `prepared_cut_seq`. A finished batch advances to the message before that, the last one it read
 * that is still there; a batch resumed after a restart reads only up to it, because later messages
 * reuse the removed numbers. A removal at or before the batch's first message still clears it:
 * nothing it read is left. */
const up = (database: DatabaseSync): void => {
  database.exec(`ALTER TABLE memory_capture_positions ADD COLUMN prepared_cut_seq INTEGER
      CHECK(prepared_cut_seq IS NULL OR (prepared_json IS NOT NULL AND prepared_cut_seq > read_seq))`)
  database.exec("DROP TRIGGER memory_capture_cut_at_removal")
  database.exec(`CREATE TRIGGER memory_capture_cut_at_removal
      AFTER DELETE ON session_messages
      WHEN EXISTS (SELECT 1 FROM memory_capture_positions WHERE session_id = OLD.session_id)
      BEGIN
        UPDATE memory_capture_positions
        SET read_seq = OLD.seq - 1, read_offset = NULL, prepared_json = NULL,
          prepared_cut_seq = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE session_id = OLD.session_id AND read_seq >= OLD.seq;
        UPDATE memory_capture_positions
        SET prepared_json = CASE WHEN ${KEEPS_NOTHING} THEN NULL ELSE prepared_json END,
          prepared_cut_seq = CASE WHEN ${KEEPS_NOTHING} THEN NULL
            ELSE MIN(COALESCE(prepared_cut_seq, OLD.seq), OLD.seq) END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE session_id = OLD.session_id AND prepared_json IS NOT NULL
          AND COALESCE(json_extract(prepared_json, '$.end.sequence'),
            json_extract(prepared_json, '$.end.progress.sequence')) >= OLD.seq;
        DELETE FROM memory_capture_backlog
        WHERE session_id = OLD.session_id AND from_seq >= OLD.seq;
        UPDATE memory_capture_backlog SET through_seq = OLD.seq - 1
        WHERE session_id = OLD.session_id AND through_seq >= OLD.seq;
      END`)
}

/** The removed message is at or before the first one the prepared batch read. A prepared batch
 * starts at the position: inside message `read_seq` when an offset is kept, else after it. */
const KEEPS_NOTHING = "OLD.seq <= read_seq + (read_offset IS NULL)"

export const captureBatchCutByRevert: Migration = {
  version: 158,
  name: "capture_batch_cut_by_revert",
  foreignKeys: { kind: "enforced" },
  up
}
