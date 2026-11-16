import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`DROP TABLE space_overview_revisions;
    DROP TABLE space_summaries;`)
}

export const dropSpaceOverview: Migration = {
  version: 167,
  name: "drop_space_overview",
  foreignKeys: { kind: "enforced" },
  up
}
