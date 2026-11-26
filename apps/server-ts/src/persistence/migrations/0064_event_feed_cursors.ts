import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

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
