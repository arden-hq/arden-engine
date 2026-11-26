import type { Migration } from "./index.js"

export const calendarChangesCursor: Migration = {
  version: 172,
  name: "calendar_changes_cursor",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(
      `INSERT OR IGNORE INTO connection_cursors
         (source, account, cursor, poll_after, polled_at, since, watched_from)
       SELECT 'calendar', substr(namespace, 40), state, NULL, updated_at, NULL, updated_at
       FROM monitor_state
       WHERE substr(namespace, 1, 39) = 'event_source:calendar.changed:calendar:'
         AND length(namespace) > 39 AND json_valid(state);
       DELETE FROM monitor_state WHERE substr(namespace, 1, 30) = 'event_source:calendar.changed:'`
    )
}
