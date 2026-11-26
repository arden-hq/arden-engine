import type { Migration } from "./index.js"

export const connectionItemDetail: Migration = {
  version: 171,
  name: "connection_item_detail",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(
      `ALTER TABLE connection_items ADD COLUMN detail TEXT CHECK(detail IS NULL OR json_valid(detail))`
    )
}
