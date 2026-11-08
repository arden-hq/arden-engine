import type { Migration } from "./index.js"

export const deskConversationFollowsDeskArchive: Migration = {
  version: 117,
  name: "desk_conversation_follows_desk_archive",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("DROP TRIGGER desk_conversation_session_guard")
    database.exec(`CREATE TRIGGER desk_conversation_session_guard
      BEFORE UPDATE OF desk_id, session_type, parent_session_id, parent_message_id, archived_at ON sessions
      WHEN EXISTS (SELECT 1 FROM desk_conversations WHERE session_id = OLD.session_id
        AND (NEW.desk_id IS NOT desk_id OR NEW.session_type != 'chat'
          OR NEW.parent_session_id IS NOT NULL OR NEW.parent_message_id IS NOT NULL
          OR (NEW.archived_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM desks
            WHERE desks.desk_id = desk_conversations.desk_id AND desks.archived_at IS NOT NULL))))
      BEGIN SELECT RAISE(ABORT, 'Desk conversation cannot be moved or archived separately'); END`)
    database.exec(`UPDATE sessions
      SET archived_at = (SELECT desk.archived_at FROM desks AS desk WHERE desk.desk_id = sessions.desk_id),
        metadata = json_set(COALESCE(metadata, '{}'), '$.archived_with_desk', json('true'))
      WHERE archived_at IS NULL
        AND desk_id IN (SELECT desk_id FROM desks WHERE archived_at IS NOT NULL)`)
  }
}
