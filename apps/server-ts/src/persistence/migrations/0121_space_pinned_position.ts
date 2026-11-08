import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(
    "ALTER TABLE desks ADD COLUMN pinned_position INTEGER CHECK(pinned_position IS NULL OR pinned_position >= 0)"
  )
}

export const spacePinnedPosition: Migration = {
  version: 121,
  name: "space_pinned_position",
  foreignKeys: { kind: "enforced" },
  up
}
