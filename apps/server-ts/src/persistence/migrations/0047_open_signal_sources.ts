import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const openSignalSources: Migration = {
  version: 47,
  name: "open_signal_sources",
  foreignKeys: {
    kind: "rebuilds",
    tables: [
      "connection_items",
      "connection_threads",
      "connection_cursors",
      "connection_item_threads"
    ]
  },
  up: (database) => {
    // Renaming a parent aside must leave its children's REFERENCES text alone,
    database.exec("PRAGMA legacy_alter_table = ON")
    try {
      rebuild(database, "connection_items", connectionItems, [
        connectionItemsThreadIndex,
        connectionItemsOwnerIndex
      ])
      rebuild(database, "connection_threads", connectionThreads, [])
      rebuild(database, "connection_cursors", connectionCursors, [])
      rebuild(database, "connection_item_threads", connectionItemThreads, [
        connectionItemThreadsIndex
      ])
    } finally {
      database.exec("PRAGMA legacy_alter_table = OFF")
    }
  }
}

const rebuild = (
  database: DatabaseSync,
  table: string,
  create: string,
  dependents: ReadonlyArray<string>
): void => {
  const columns = database
    .prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)
    .all()
    .map((row) => `"${String(row["name"])}"`)
    .join(", ")
  const prior = `${table}_prior`
  database.exec(`ALTER TABLE "${table}" RENAME TO "${prior}"`)
  database.exec(create)
  database.exec(
    `INSERT INTO "${table}" (rowid, ${columns}) SELECT rowid, ${columns} FROM "${prior}"`
  )
  database.exec(`DROP TABLE "${prior}"`)
  for (const statement of dependents) database.exec(statement)
}

const source = "source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 64)"

const connectionItems = `CREATE TABLE connection_items (
      item_id TEXT PRIMARY KEY CHECK(length(item_id) > 0),
      ${source},
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
    )`

const connectionItemsThreadIndex = `CREATE INDEX idx_connection_items_thread
      ON connection_items(source, account, thread_key)`

const connectionItemsOwnerIndex = `CREATE INDEX idx_connection_items_owner
      ON connection_items(owner_desk_id, routed_at)`

const connectionThreads = `CREATE TABLE connection_threads (
      ${source},
      account TEXT NOT NULL CHECK(length(account) > 0),
      thread_key TEXT NOT NULL CHECK(length(thread_key) > 0),
      owner_desk_id TEXT REFERENCES desks(desk_id) ON DELETE CASCADE,
      basis TEXT NOT NULL CHECK(basis IN ('thread', 'router', 'user')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, account, thread_key),
      CHECK(owner_desk_id IS NOT NULL OR basis = 'user')
    )`

const connectionCursors = `CREATE TABLE connection_cursors (
      ${source},
      account TEXT NOT NULL CHECK(length(account) > 0),
      cursor TEXT,
      poll_after TEXT,
      polled_at TEXT NOT NULL, since TEXT,
      PRIMARY KEY (source, account)
    )`

const connectionItemThreads = `CREATE TABLE connection_item_threads (
      item_id TEXT PRIMARY KEY CHECK(length(item_id) > 0),
      ${source},
      account TEXT NOT NULL CHECK(length(account) > 0),
      thread_key TEXT NOT NULL CHECK(length(thread_key) > 0)
    )`

const connectionItemThreadsIndex = `CREATE INDEX idx_connection_item_threads_thread
      ON connection_item_threads(source, account, thread_key)`
