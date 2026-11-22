import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const IMMUTABLE_RUN = "automation_runs_immutable_context"

const up = (database: DatabaseSync): void => {
  database.exec("UPDATE scheduled_tasks SET handler = 'events' WHERE handler = 'urgent_events'")
  const trigger = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(IMMUTABLE_RUN)?.["sql"]
  if (typeof trigger === "string") database.exec(`DROP TRIGGER ${IMMUTABLE_RUN}`)
  database.exec("UPDATE automation_runs SET handler = 'events' WHERE handler = 'urgent_events'")
  if (typeof trigger === "string") database.exec(trigger)
}

export const eventsHandlerId: Migration = {
  version: 184,
  name: "events_handler",
  foreignKeys: { kind: "enforced" },
  up
}
