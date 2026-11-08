import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE desk_tasks ADD COLUMN origin_message_id TEXT")
  database.exec("ALTER TABLE desk_tasks ADD COLUMN original_body TEXT")
}

export const taskRequestAnchor: Migration = {
  version: 73,
  name: "task_request_anchor",
  foreignKeys: { kind: "enforced" },
  up
}
