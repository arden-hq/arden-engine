import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE monitor_state SET state = json_remove(state, '$.maxMessages')
    WHERE namespace = 'intelligence_settings'`)
}

export const dropMessageLimit: Migration = {
  version: 106,
  name: "drop_message_limit",
  foreignKeys: { kind: "enforced" },
  up
}
