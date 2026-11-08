import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** Journal retention walks `journal_records` in insertion order behind a
 * cutoff. A cursor remembers where each walk stopped, so a restart resumes;
 * a held run is one whose rows were skipped while it was pinned. */
const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE journal_retention_cursors (
      name TEXT PRIMARY KEY CHECK(length(name) > 0),
      after_rowid INTEGER NOT NULL CHECK(after_rowid >= 0),
      stream_id TEXT,
      sequence INTEGER
    ) WITHOUT ROWID`)
  database.exec(`CREATE TABLE journal_retention_held (
      run_id TEXT PRIMARY KEY CHECK(length(run_id) > 0),
      stream_id TEXT NOT NULL REFERENCES journal_streams(stream_id) ON DELETE CASCADE,
      from_sequence INTEGER NOT NULL CHECK(from_sequence >= 1),
      through_sequence INTEGER NOT NULL CHECK(through_sequence >= from_sequence)
    ) WITHOUT ROWID`)
}

export const journalRetentionCursors: Migration = {
  version: 142,
  name: "journal_retention_cursors",
  foreignKeys: { kind: "enforced" },
  up
}
