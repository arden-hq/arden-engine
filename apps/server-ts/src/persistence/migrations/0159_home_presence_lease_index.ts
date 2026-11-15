import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** "Is the owner around" (`ownerPresentSql`) asks for a presence lease that has not run out.
 * `home_presence` keeps a row for every desktop client ever seen, so without an index that
 * question read every row whenever no lease was live. No row changes. */
const up = (database: DatabaseSync): void => {
  database.exec("CREATE INDEX idx_home_presence_lease ON home_presence(lease_until)")
}

export const homePresenceLeaseIndex: Migration = {
  version: 159,
  name: "home_presence_lease_index",
  foreignKeys: { kind: "enforced" },
  up
}
