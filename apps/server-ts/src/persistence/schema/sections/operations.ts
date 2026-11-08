import type { OperationalSchemaSection } from "../section.js"

export const operationsSchemaSection = {
  name: "operations",
  storageDomain: "operations",
  tables: [
    "home_presence",
    "home_letter",
    "home_letters",
    "inbox_reads",
    "inbox_dismissals",
    "monitor_state",
    "wiki_rename_approvals"
  ],
  indexes: ["idx_wiki_rename_approvals_open_page", "idx_wiki_rename_approvals_open_created"],
  triggers: [],
  statements: [
    `CREATE TABLE home_presence (
      client_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL CHECK(sequence >= 0),
      last_seen_at TEXT,
      lease_until TEXT NOT NULL
    )`,
    `CREATE TABLE home_letter (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      window_id TEXT NOT NULL,
      window_since TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      source_fingerprint TEXT,
      run_id TEXT,
      generated_at TEXT,
      body_json TEXT CHECK(body_json IS NULL OR json_valid(body_json)),
      sources_json TEXT CHECK(sources_json IS NULL OR json_valid(sources_json)),
      snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
      CHECK ((run_id IS NULL AND source_fingerprint IS NULL AND generated_at IS NULL AND body_json IS NULL AND sources_json IS NULL AND snapshot_json IS NULL)
        OR (run_id IS NOT NULL AND source_fingerprint IS NOT NULL AND generated_at IS NOT NULL AND body_json IS NOT NULL AND sources_json IS NOT NULL AND snapshot_json IS NOT NULL))
    )`,
    `CREATE TABLE home_letters (
      letter_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      window_id TEXT NOT NULL,
      window_since TEXT NOT NULL,
      window_through TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      body_json TEXT NOT NULL CHECK(json_valid(body_json)),
      sources_json TEXT NOT NULL CHECK(json_valid(sources_json))
    )`,
    `CREATE TABLE inbox_reads (
      item_key TEXT PRIMARY KEY,
      read_at TEXT NOT NULL
    )`,
    `CREATE TABLE inbox_dismissals (
      item_key TEXT PRIMARY KEY,
      dismissed_at TEXT NOT NULL
    )`,
    `CREATE TABLE monitor_state (
      namespace TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE wiki_rename_approvals (
      approval_id TEXT PRIMARY KEY CHECK (length(approval_id) > 0),
      page_id TEXT NOT NULL CHECK (length(page_id) > 0),
      plan_json TEXT NOT NULL CHECK (json_valid(plan_json) AND json_type(plan_json) = 'object'),
      status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'accepted', 'rejected')),
      created_at TEXT NOT NULL,
      commit_id TEXT,
      resolution TEXT,
      CHECK (
        (status IN ('pending', 'applying', 'rejected') AND commit_id IS NULL)
        OR (status = 'accepted' AND commit_id IS NOT NULL)
      )
    )`,
    `CREATE UNIQUE INDEX idx_wiki_rename_approvals_open_page
      ON wiki_rename_approvals(page_id)
      WHERE status IN ('pending', 'applying')`,
    `CREATE INDEX idx_wiki_rename_approvals_open_created
      ON wiki_rename_approvals(status, created_at)`
  ]
} as const satisfies OperationalSchemaSection
