import type { OperationalSchemaSection } from "../section.js"
import { journalSqliteSchema } from "@arden-hq/journal/effect"

export const contextJournalSchemaSection = {
  name: "context.journal",
  storageDomain: "journal",
  tables: [
    ...journalSqliteSchema.tables,
    "session_event_checkpoints",
    "journal_retention_cursors",
    "journal_retention_held"
  ],
  indexes: [
    ...journalSqliteSchema.indexes,
    "idx_journal_question_changes",
    "idx_journal_retention_held_stream_id",
    "idx_journal_question_latest"
  ],
  triggers: [],
  statements: [
    ...journalSqliteSchema.statements,
    // Question reads repeat this WHERE to use the partial index: https://www.sqlite.org/partialindex.html#queries_using_partial_indexes
    `CREATE INDEX idx_journal_question_changes
      ON journal_records(stream_id, event_type, sequence)
      WHERE event_type = 'question_changed'`,
    `CREATE TABLE session_event_checkpoints (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      checkpoint_seq INTEGER NOT NULL CHECK(checkpoint_seq >= 0)
    )`,
    `CREATE TABLE journal_retention_cursors (
      name TEXT PRIMARY KEY CHECK(length(name) > 0),
      after_rowid INTEGER NOT NULL CHECK(after_rowid >= 0),
      stream_id TEXT,
      sequence INTEGER
    ) WITHOUT ROWID`,
    `CREATE TABLE journal_retention_held (
      run_id TEXT PRIMARY KEY CHECK(length(run_id) > 0),
      stream_id TEXT NOT NULL REFERENCES journal_streams(stream_id) ON DELETE CASCADE,
      from_sequence INTEGER NOT NULL CHECK(from_sequence >= 1),
      through_sequence INTEGER NOT NULL CHECK(through_sequence >= from_sequence)
    ) WITHOUT ROWID`,
    "CREATE INDEX idx_journal_retention_held_stream_id ON journal_retention_held(stream_id)",
    `CREATE INDEX idx_journal_question_latest
      ON journal_records(stream_id, json_extract(data_json, '$.question_id'), sequence)
      WHERE event_type = 'question_changed'`
  ]
} as const satisfies OperationalSchemaSection
