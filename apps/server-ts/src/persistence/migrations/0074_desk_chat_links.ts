import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE desk_chat_links (
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      linked_at TEXT NOT NULL,
      PRIMARY KEY (desk_id, session_id)
    )`)
}

export const deskChatLinks: Migration = {
  version: 74,
  name: "desk_chat_links",
  foreignKeys: { kind: "enforced" },
  up
}
