import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE automation_event_queue
    SET next_attempt_at = not_before_at
    WHERE not_before_at IS NOT NULL
      AND (next_attempt_at IS NULL OR next_attempt_at < not_before_at)`)
  database.exec("ALTER TABLE automation_event_queue DROP COLUMN not_before_at")
  database.exec("ALTER TABLE automation_event_queue DROP COLUMN last_event_at")
  database.exec(`UPDATE monitor_state SET namespace = 'event_source:email.received:connection_items'
    WHERE namespace = 'event_feed:connection_items'`)
  database.exec("DELETE FROM monitor_state WHERE substr(namespace, 1, 11) = 'event_feed:'")
}

export const oneQueueIngress: Migration = {
  version: 70,
  name: "one_queue_ingress",
  foreignKeys: { kind: "enforced" },
  up
}
