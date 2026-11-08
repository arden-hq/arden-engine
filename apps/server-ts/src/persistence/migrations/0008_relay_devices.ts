import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE paired_devices (
      dev TEXT PRIMARY KEY CHECK(length(dev) = 22),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
      ed_pub TEXT NOT NULL CHECK(length(ed_pub) = 43),
      x_pub TEXT NOT NULL CHECK(length(x_pub) = 43),
      added_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    )`)
  database.exec(`CREATE TABLE relay_commands (
      cid TEXT PRIMARY KEY CHECK(length(cid) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK(kind IN ('send', 'answer', 'decide', 'stop', 'capture')),
      state TEXT NOT NULL CHECK(state IN ('running', 'done', 'stopping', 'rejected')),
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
      created_at TEXT NOT NULL
    )`)
  database.exec(`CREATE INDEX relay_commands_created ON relay_commands(created_at)`)
}

export const relayDevices: Migration = {
  version: 8,
  name: "relay_devices",
  foreignKeys: { kind: "enforced" },
  up
}
