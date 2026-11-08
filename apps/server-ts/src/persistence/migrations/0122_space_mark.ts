import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE desks ADD COLUMN mark TEXT CHECK(mark IS NULL OR json_valid(mark))")
}

export const spaceMark: Migration = {
  version: 122,
  name: "space_mark",
  foreignKeys: { kind: "enforced" },
  up
}
