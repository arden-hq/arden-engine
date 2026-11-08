import type { Migration } from "./index.js"

export const homeOffers: Migration = {
  version: 30,
  name: "home_offers",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE home_offers (
      offer_id TEXT PRIMARY KEY CHECK(length(offer_id) > 0),
      item_id TEXT UNIQUE REFERENCES connection_items(item_id) ON DELETE SET NULL,
      source TEXT NOT NULL CHECK(source IN ('gmail', 'github')),
      account TEXT NOT NULL CHECK(length(account) > 0),
      thread_key TEXT NOT NULL CHECK(length(thread_key) > 0),
      text TEXT NOT NULL CHECK(length(trim(text)) > 0 AND length(text) <= 200),
      why TEXT NOT NULL CHECK(length(why) <= 500),
      item_title TEXT NOT NULL CHECK(length(item_title) <= 300),
      item_from TEXT CHECK(item_from IS NULL OR length(item_from) <= 200),
      status TEXT NOT NULL CHECK(status IN ('held', 'offered', 'accepted', 'rejected')),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      desk_id TEXT REFERENCES desks(desk_id) ON DELETE SET NULL,
      task_item_id TEXT REFERENCES desk_tasks(item_id) ON DELETE SET NULL,
      settlement_client_id TEXT,
      settlement_decision TEXT CHECK(settlement_decision IN ('accept', 'reject') OR settlement_decision IS NULL),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      CHECK((status IN ('held', 'offered')) = (settled_at IS NULL AND settlement_decision IS NULL AND settlement_client_id IS NULL)),
      CHECK(status != 'accepted' OR settlement_decision = 'accept'),
      CHECK(status != 'rejected' OR settlement_decision = 'reject')
    )`)
    database.exec(`CREATE INDEX idx_home_offers_thread
      ON home_offers(source, account, thread_key)`)
    database.exec(`CREATE INDEX idx_home_offers_status
      ON home_offers(status, created_at)`)
  }
}
