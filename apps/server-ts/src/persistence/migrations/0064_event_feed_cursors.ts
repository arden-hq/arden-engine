import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/**
 * Event feed cursors that hold across deletes, restarts and new accounts:
 * - the asks feed follows the Session journal's sequence instead of one
 *   rowid per table (SQLite hands a deleted newest rowid out again), so its
 *   old cursor goes and the feed starts again from the asks still settling;
 * - a calendar source cursor is keyed by its event type, so the runtime can
 *   release it when no trigger listens for that event;
 * - a connection account remembers when it started being watched; an
 *   account already watched counts as watched from the start (NULL).
 * A few `monitor_state` rows and one added column: no table is rewritten.
 */
const up = (database: DatabaseSync): void => {
  database.exec("DELETE FROM monitor_state WHERE namespace = 'event_feed:asks'")
  database.exec(`UPDATE monitor_state
    SET namespace = 'event_source:calendar.changed:' || substr(namespace, length('event_source:') + 1)
    WHERE namespace LIKE 'event_source:calendar:%'`)
  database.exec("ALTER TABLE connection_cursors ADD COLUMN watched_from TEXT")
}

export const eventFeedCursors: Migration = {
  version: 64,
  name: "event_feed_cursors",
  foreignKeys: { kind: "enforced" },
  up
}
