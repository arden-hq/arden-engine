import type { OperationalSchemaSection } from "../section.js"

export const relaySchemaSection = {
  name: "relay",
  storageDomain: "configuration",
  tables: ["paired_devices", "relay_commands", "relay_push_notified"],
  indexes: ["relay_commands_created"],
  triggers: [],
  statements: [
    `CREATE TABLE paired_devices (
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
    )`,
    `CREATE TABLE relay_commands (
      cid TEXT PRIMARY KEY CHECK(length(cid) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK(kind IN ('send', 'answer', 'decide', 'stop', 'capture', 'register_push')),
      state TEXT NOT NULL CHECK(state IN ('running', 'done', 'stopping', 'rejected')),
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX relay_commands_created ON relay_commands(created_at)`,
    `CREATE TABLE relay_push_notified (
      key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 256),
      notified_at TEXT NOT NULL
    )`
  ]
} as const satisfies OperationalSchemaSection
