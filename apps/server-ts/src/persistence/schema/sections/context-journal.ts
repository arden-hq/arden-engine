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
  indexes: [...journalSqliteSchema.indexes, "idx_journal_question_changes"],
  triggers: [],
  statements: [
    ...journalSqliteSchema.statements,
    // Question reads find each question's latest change among these records;
    // they repeat this WHERE so SQLite can use the partial index.
    `CREATE INDEX idx_journal_question_changes
      ON journal_records(stream_id, event_type, sequence)
      WHERE event_type = 'question_changed'`,
    `CREATE TABLE session_event_checkpoints (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      checkpoint_seq INTEGER NOT NULL CHECK(checkpoint_seq >= 0)
    )`,
    // Journal retention: where each walk over the journal stopped, and the runs
    // whose rows it skipped while they were pinned.
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
    ) WITHOUT ROWID`
  ]
} as const satisfies OperationalSchemaSection
