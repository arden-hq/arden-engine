import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** Indexes in the order the chat lists ask for.
 *
 * The chat list read every live chat through the index on archived_at and
 * sorted them all to show the newest hundred. These hold the chats by
 * archived_at and then in each list order (latest activity; last opened), and
 * a Space's or a parent chat's chats the same way, so each list reads a page
 * and stops. The first replaces idx_sessions_archived. (Without the Space and
 * parent ones, SQLite read every chat in activity order to find one Space's.)
 *
 * Search listed the owner's named chats through the index of every chat of
 * the same type, forks included; `idx_sessions_owner_chats` holds only the
 * owner's own chats, by activity. An Automation's own chat was found by
 * reading every chat it ever forked; `idx_sessions_automation_channel` holds
 * only the live channels, per Automation. The conditions repeat the queries'
 * word for word, so SQLite can use these partial indexes. */
const up = (database: DatabaseSync): void => {
  database.exec(`CREATE INDEX idx_sessions_archived_activity
      ON sessions(archived_at, last_activity DESC, session_id DESC)`)
  database.exec("DROP INDEX idx_sessions_archived")
  database.exec(`CREATE INDEX idx_sessions_archived_accessed
      ON sessions(archived_at, COALESCE(last_accessed_at, last_activity) DESC, session_id DESC)`)
  database.exec(`CREATE INDEX idx_sessions_space_live
      ON sessions(space_id, archived_at, last_activity DESC, session_id DESC)`)
  database.exec(`CREATE INDEX idx_sessions_parent_live
      ON sessions(parent_session_id, archived_at, last_activity DESC, session_id DESC)`)
  database.exec(`CREATE INDEX idx_sessions_owner_chats ON sessions(last_activity DESC, session_id DESC)
      WHERE archived_at IS NULL AND session_type = 'chat'
        AND parent_session_id IS NULL AND parent_message_id IS NULL`)
  database.exec(`CREATE INDEX idx_sessions_automation_channel
      ON sessions(origin_automation_id, started_at DESC)
      WHERE session_type = 'channel' AND archived_at IS NULL`)
}

export const chatListOrders: Migration = {
  version: 152,
  name: "chat_list_orders",
  foreignKeys: { kind: "enforced" },
  up
}
