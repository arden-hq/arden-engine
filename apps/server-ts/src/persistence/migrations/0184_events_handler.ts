import type { Migration } from "./index.js"

export const eventsHandlerId: Migration = {
  version: 184,
  name: "events_handler",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec("UPDATE scheduled_tasks SET handler = 'events' WHERE handler = 'urgent_events'")
}
