import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const pairedDevices = `CREATE TABLE paired_devices (
      dev TEXT PRIMARY KEY CHECK(length(dev) = 22),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
      ed_pub TEXT NOT NULL CHECK(length(ed_pub) = 43),
      x_pub TEXT NOT NULL CHECK(length(x_pub) = 43),
      added_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT,
      push_token TEXT CHECK(push_token IS NULL OR length(push_token) BETWEEN 64 AND 200),
      push_env TEXT CHECK(push_env IS NULL OR push_env IN ('sandbox', 'production')),
      push_topic TEXT CHECK(push_topic IS NULL OR length(push_topic) BETWEEN 1 AND 128),
      CHECK((push_token IS NULL) = (push_env IS NULL) AND (push_token IS NULL) = (push_topic IS NULL))
    )`

const relayCommands = `CREATE TABLE relay_commands (
      cid TEXT PRIMARY KEY CHECK(length(cid) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK(kind IN ('send', 'answer', 'decide', 'stop', 'capture', 'register_push')),
      state TEXT NOT NULL CHECK(state IN ('running', 'done', 'stopping', 'rejected')),
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
      created_at TEXT NOT NULL
    )`

const up = (database: DatabaseSync): void => {
  database.exec("ALTER TABLE paired_devices RENAME TO paired_devices_prior")
  database.exec(pairedDevices)
  database.exec(`INSERT INTO paired_devices (dev, name, ed_pub, x_pub, added_at, last_seen_at, revoked_at)
    SELECT dev, name, ed_pub, x_pub, added_at, last_seen_at, revoked_at FROM paired_devices_prior`)
  database.exec("DROP TABLE paired_devices_prior")
  database.exec("DROP INDEX relay_commands_created")
  database.exec("ALTER TABLE relay_commands RENAME TO relay_commands_prior")
  database.exec(relayCommands)
  database.exec(`INSERT INTO relay_commands (cid, kind, state, result_json, created_at)
    SELECT cid, kind, state, result_json, created_at FROM relay_commands_prior`)
  database.exec("DROP TABLE relay_commands_prior")
  database.exec(`CREATE INDEX relay_commands_created ON relay_commands(created_at)`)
}

export const relayPush: Migration = {
  version: 9,
  name: "relay_push",
  foreignKeys: { kind: "rebuilds", tables: ["paired_devices", "relay_commands"] },
  up
}
