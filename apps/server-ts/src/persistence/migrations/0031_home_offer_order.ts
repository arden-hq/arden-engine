import type { Migration } from "./index.js"

export const homeOfferOrder: Migration = {
  version: 31,
  name: "home_offer_order",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("ALTER TABLE home_offers ADD COLUMN seq INTEGER NOT NULL DEFAULT 0")
    database.exec("UPDATE home_offers SET seq = rowid")
  }
}
