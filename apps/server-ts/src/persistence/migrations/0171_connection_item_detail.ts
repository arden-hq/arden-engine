import type { Migration } from "./index.js"

/**
 * An item can carry its source's own fields as a small JSON document (a
 * calendar change: its kind, start, attendees), so one stored item is enough
 * to publish that source's Automation event.
 */
export const connectionItemDetail: Migration = {
  version: 171,
  name: "connection_item_detail",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(
      `ALTER TABLE connection_items ADD COLUMN detail TEXT CHECK(detail IS NULL OR json_valid(detail))`
    )
}
