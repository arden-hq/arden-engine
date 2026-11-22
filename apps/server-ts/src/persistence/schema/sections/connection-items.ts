import type { OperationalSchemaSection } from "../section.js"
import { EVENT_THREADS_TABLE } from "../../migrations/0183_main_space.js"
import {
  CONNECTION_ITEMS_TABLE,
  CONNECTION_ITEMS_THREAD_INDEX
} from "../../migrations/0185_items_unrouted.js"

export const connectionItemsSchemaSection = {
  name: "connection-items",
  storageDomain: "work",
  tables: ["connection_items", "connection_cursors", "connection_item_threads", "event_threads"],
  indexes: ["idx_connection_items_thread", "idx_connection_item_threads_thread"],
  triggers: [],
  statements: [
    CONNECTION_ITEMS_TABLE,
    CONNECTION_ITEMS_THREAD_INDEX,
    `CREATE TABLE connection_cursors (
      source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 64),
      account TEXT NOT NULL CHECK(length(account) > 0),
      cursor TEXT,
      poll_after TEXT,
      polled_at TEXT NOT NULL, since TEXT, watched_from TEXT,
      PRIMARY KEY (source, account)
    )`,
    `CREATE TABLE connection_item_threads (
      item_id TEXT PRIMARY KEY CHECK(length(item_id) > 0),
      source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 64),
      account TEXT NOT NULL CHECK(length(account) > 0),
      thread_key TEXT NOT NULL CHECK(length(thread_key) > 0)
    )`,
    `CREATE INDEX idx_connection_item_threads_thread
      ON connection_item_threads(source, account, thread_key)`,
    EVENT_THREADS_TABLE
  ]
} as const satisfies OperationalSchemaSection
