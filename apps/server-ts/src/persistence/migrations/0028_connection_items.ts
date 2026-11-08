import type { Migration } from "./index.js"

export const connectionItems: Migration = {
  version: 28,
  name: "connection_items",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE connection_items (
      item_id TEXT PRIMARY KEY CHECK(length(item_id) > 0),
      source TEXT NOT NULL CHECK(source IN ('gmail', 'github')),
      account TEXT NOT NULL CHECK(length(account) > 0),
      external_id TEXT NOT NULL CHECK(length(external_id) > 0),
      thread_key TEXT NOT NULL CHECK(length(thread_key) > 0),
      title TEXT NOT NULL CHECK(length(title) <= 300),
      sender TEXT CHECK(sender IS NULL OR length(sender) <= 200),
      received_at TEXT NOT NULL,
      snippet TEXT NOT NULL CHECK(length(snippet) <= 300),
      fetched_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'routed')),
      owner_desk_id TEXT REFERENCES desks(desk_id) ON DELETE SET NULL,
      route_basis TEXT CHECK(route_basis IS NULL OR route_basis IN ('thread', 'conflict', 'router', 'home', 'user')),
      route_reason TEXT CHECK(route_reason IS NULL OR length(route_reason) <= 500),
      routed_at TEXT,
      UNIQUE(source, account, external_id),
      CHECK((state = 'pending') = (routed_at IS NULL)),
      CHECK(state = 'routed' OR (owner_desk_id IS NULL AND route_basis IS NULL AND route_reason IS NULL)),
      CHECK(state = 'pending' OR (route_basis IS NOT NULL AND route_reason IS NOT NULL))
    )`)
    database.exec(`CREATE INDEX idx_connection_items_thread
      ON connection_items(source, account, thread_key)`)
    database.exec(`CREATE INDEX idx_connection_items_owner
      ON connection_items(owner_desk_id, routed_at)`)
    database.exec(`CREATE TABLE connection_threads (
      source TEXT NOT NULL CHECK(source IN ('gmail', 'github')),
      account TEXT NOT NULL CHECK(length(account) > 0),
      thread_key TEXT NOT NULL CHECK(length(thread_key) > 0),
      owner_desk_id TEXT REFERENCES desks(desk_id) ON DELETE CASCADE,
      basis TEXT NOT NULL CHECK(basis IN ('thread', 'router', 'user')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, account, thread_key),
      CHECK(owner_desk_id IS NOT NULL OR basis = 'user')
    )`)
    database.exec(`CREATE TABLE connection_cursors (
      source TEXT NOT NULL CHECK(source IN ('gmail', 'github')),
      account TEXT NOT NULL CHECK(length(account) > 0),
      cursor TEXT,
      poll_after TEXT,
      polled_at TEXT NOT NULL,
      PRIMARY KEY (source, account)
    )`)
  }
}
