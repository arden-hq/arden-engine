import type { OperationalSchemaSection } from "../section.js"

export const contextSearchSyncSchemaSection = {
  name: "context.search-sync",
  storageDomain: "search_sync",
  tables: ["transcript_search_clock", "transcript_search_changes", "transcript_search_source"],
  indexes: [],
  triggers: [
    "session_messages_search_ai",
    "session_messages_search_ad",
    "session_messages_search_au"
  ],
  statements: [
    `CREATE TABLE transcript_search_clock (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      head_sequence INTEGER NOT NULL DEFAULT 0 CHECK(head_sequence >= 0)
    )`,
    "INSERT INTO transcript_search_clock (singleton_id, head_sequence) VALUES (1, 0)",
    `CREATE TABLE transcript_search_source (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      source_id TEXT NOT NULL UNIQUE CHECK(length(source_id) = 32)
    )`,
    "INSERT INTO transcript_search_source (singleton_id, source_id) VALUES (1, lower(hex(randomblob(16))))",
    `CREATE TABLE transcript_search_changes (
      sequence INTEGER PRIMARY KEY CHECK(sequence >= 1),
      message_rowid INTEGER NOT NULL
    )`,
    `CREATE TRIGGER session_messages_search_ai
      AFTER INSERT ON session_messages BEGIN
        UPDATE transcript_search_clock SET head_sequence = head_sequence + 1 WHERE singleton_id = 1;
        INSERT INTO transcript_search_changes(sequence, message_rowid)
        SELECT head_sequence, new.message_rowid FROM transcript_search_clock WHERE singleton_id = 1;
      END`,
    `CREATE TRIGGER session_messages_search_ad
      AFTER DELETE ON session_messages BEGIN
        UPDATE transcript_search_clock SET head_sequence = head_sequence + 1 WHERE singleton_id = 1;
        INSERT INTO transcript_search_changes(sequence, message_rowid)
        SELECT head_sequence, old.message_rowid FROM transcript_search_clock WHERE singleton_id = 1;
      END`,
    `CREATE TRIGGER session_messages_search_au
      AFTER UPDATE OF search_text ON session_messages BEGIN
        UPDATE transcript_search_clock SET head_sequence = head_sequence + 1 WHERE singleton_id = 1;
        INSERT INTO transcript_search_changes(sequence, message_rowid)
        SELECT head_sequence, new.message_rowid FROM transcript_search_clock WHERE singleton_id = 1;
      END`
  ]
} as const satisfies OperationalSchemaSection
