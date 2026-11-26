import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec("CREATE INDEX idx_home_presence_lease ON home_presence(lease_until)")
}

export const homePresenceLeaseIndex: Migration = {
  version: 159,
  name: "home_presence_lease_index",
  foreignKeys: { kind: "enforced" },
  up
}
