import { SqliteClient } from "@effect/sql-sqlite-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { initializeJournalSchema, truncateBeforeInTransaction } from "../src/effect/runtime.js"

const withSql = async <A, E>(
  label: string,
  body: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), label))
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* initializeJournalSchema(sql)
        return yield* body(sql)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: join(directory, "journal.sqlite") })))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it("truncates only matching records below the boundary without advancing the replay floor", () =>
  withSql("journal-truncate-", (sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO journal_streams(stream_id, head_sequence, retained_from_sequence)
      VALUES ('lifecycle', 4, 1)`
      for (const record of [
        { sequence: 1, eventType: "session_created", data: { session: { session_id: "agent" } } },
        {
          sequence: 2,
          eventType: "chat_input_committed",
          data: { session: { session_id: "other" } }
        },
        { sequence: 3, eventType: "session_activity", data: { session: { session_id: "agent" } } },
        { sequence: 4, eventType: "session_activity", data: { session: { session_id: "other" } } }
      ]) {
        yield* sql`INSERT INTO journal_records(stream_id,sequence,event_type,data_json,attributes_json,created_at)
        VALUES ('lifecycle', ${record.sequence}, ${record.eventType}, ${JSON.stringify(record.data)},
          '{}', '2026-09-19T00:00:00Z')`
      }
      yield* sql.withTransaction(
        truncateBeforeInTransaction(sql, {
          streamId: "lifecycle",
          beforeSequence: 3,
          where: sql`event_type IN ('session_created', 'session_activity')
        AND json_extract(data_json, '$.session.session_id') = ${"agent"}`
        })
      )
      expect(
        yield* sql`SELECT sequence FROM journal_records WHERE stream_id = 'lifecycle' ORDER BY sequence`
      ).toEqual([{ sequence: 2 }, { sequence: 3 }, { sequence: 4 }])
      expect(
        yield* sql`SELECT head_sequence, retained_from_sequence FROM journal_streams
      WHERE stream_id = 'lifecycle'`
      ).toEqual([{ head_sequence: 4, retained_from_sequence: 1 }])
    })
  ))
