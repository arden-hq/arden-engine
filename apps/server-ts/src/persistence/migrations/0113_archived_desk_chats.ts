import type { Migration } from "./index.js"

export const archivedDeskChats: Migration = {
  version: 113,
  name: "archived_desk_chats",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`UPDATE sessions
      SET archived_at = (SELECT desk.archived_at FROM desks AS desk WHERE desk.desk_id = sessions.desk_id),
        metadata = json_set(COALESCE(metadata, '{}'), '$.archived_with_desk', json('true'))
      WHERE archived_at IS NULL
        AND desk_id IN (SELECT desk_id FROM desks WHERE archived_at IS NOT NULL)
        AND session_id NOT IN (SELECT session_id FROM desk_conversations)`)
  }
}
