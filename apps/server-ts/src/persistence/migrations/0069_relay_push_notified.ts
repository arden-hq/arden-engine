import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE relay_push_notified (
      key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 256),
      notified_at TEXT NOT NULL
    )`)
  database.exec("DELETE FROM monitor_state WHERE namespace = 'relay_push_cursor'")
}

export const relayPushNotified: Migration = {
  version: 69,
  name: "relay_push_notified",
  foreignKeys: { kind: "enforced" },
  up
}
