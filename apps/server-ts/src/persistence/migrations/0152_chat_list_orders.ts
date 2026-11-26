import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

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
