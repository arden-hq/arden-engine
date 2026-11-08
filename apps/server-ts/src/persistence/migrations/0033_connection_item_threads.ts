import type { Migration } from "./index.js"

export const connectionItemThreads: Migration = {
  version: 33,
  name: "connection_item_threads",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE connection_item_threads (
      item_id TEXT PRIMARY KEY CHECK(length(item_id) > 0),
      source TEXT NOT NULL CHECK(source IN ('gmail', 'github')),
      account TEXT NOT NULL CHECK(length(account) > 0),
      thread_key TEXT NOT NULL CHECK(length(thread_key) > 0)
    )`)
    database.exec(`CREATE INDEX idx_connection_item_threads_thread
      ON connection_item_threads(source, account, thread_key)`)
    database.exec(`INSERT INTO connection_item_threads (item_id, source, account, thread_key)
      SELECT item_id, source, account, thread_key FROM connection_items`)
  }
}
