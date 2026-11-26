import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import { journalError, type JournalError } from "./contracts.js"

export const journalSqliteSchema = {
  tables: ["journal_streams", "journal_records"],
  indexes: [],
  statements: [
    `CREATE TABLE IF NOT EXISTS journal_streams (
      stream_id TEXT PRIMARY KEY,
      head_sequence INTEGER NOT NULL CHECK (head_sequence >= 0),
      retained_from_sequence INTEGER CHECK (
        retained_from_sequence IS NULL OR
        (retained_from_sequence >= 1 AND retained_from_sequence <= head_sequence)
      )
    )`,
    `CREATE TABLE IF NOT EXISTS journal_records (
      stream_id TEXT NOT NULL REFERENCES journal_streams(stream_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      event_type TEXT NOT NULL CHECK (length(event_type) > 0),
      data_json TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (stream_id, sequence)
    )`
  ]
} as const

export const initializeJournalSchema = Effect.fn("Journal.initializeSchema")(function* (
  sql: SqlClient.SqlClient
): Effect.fn.Return<void, JournalError> {
  yield* Effect.forEach(journalSqliteSchema.statements, (statement) => sql.unsafe(statement), {
    discard: true
  }).pipe(
    Effect.mapError((cause) =>
      journalError("initialize", "storage", "Could not initialize journal schema", cause)
    )
  )
  yield* Effect.forEach(
    [
      "SELECT stream_id, head_sequence, retained_from_sequence FROM journal_streams LIMIT 0",
      `SELECT stream_id, sequence, event_type, data_json, attributes_json, created_at
     FROM journal_records LIMIT 0`
    ],
    (statement) => sql.unsafe(statement),
    { discard: true }
  ).pipe(
    Effect.mapError((cause) =>
      journalError("initialize", "storage", "Existing journal schema is incompatible", cause)
    )
  )
})
