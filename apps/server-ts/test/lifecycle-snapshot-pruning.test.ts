import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { appendInTransaction, readHeadSequence } from "@arden-hq/journal/effect"
import { expect, it } from "vitest"
import {
  SESSION_LIFECYCLE_STREAM_ID,
  SessionLifecycleEvents
} from "../src/persistence/sessions/events.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const activity = (sessionId: string) => ({
  type: "session_activity",
  data: { type: "session_activity", session: { session_id: sessionId } }
})
const question = { type: "question_changed", data: { question_id: "q1" } }
const anonymous = { type: "session_activity", data: { type: "session_activity", session: {} } }

it("prunes only superseded Session snapshots the trigger listener has read", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const events = yield* SessionLifecycleEvents
      const base = (yield* readHeadSequence(sql, SESSION_LIFECYCLE_STREAM_ID)) ?? 0
      yield* sql.withTransaction(
        appendInTransaction(sql, SESSION_LIFECYCLE_STREAM_ID, [
          activity("A"),
          activity("B"),
          question,
          activity("A"),
          question,
          activity("A"),
          activity("B"),
          activity("C"),
          activity("A")
        ])
      )
      const remaining = () =>
        sql<{ readonly sequence: number }>`
            SELECT sequence FROM journal_records
            WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID} AND sequence > ${base}
            ORDER BY sequence`.pipe(Effect.map((rows) => rows.map((row) => row.sequence - base)))

      yield* sql`DELETE FROM automation_trigger_cursor`
      const withoutCursor = yield* events.pruneSupersededSnapshots()
      const afterNoCursor = yield* remaining()

      yield* sql`INSERT INTO automation_trigger_cursor (stream_id, after_sequence)
          VALUES (${SESSION_LIFECYCLE_STREAM_ID}, ${base + 5})`
      const pruned = yield* events.pruneSupersededSnapshots()
      return { withoutCursor, afterNoCursor, pruned, after: yield* remaining() }
    })
  )
  expect(outcome).toEqual({
    withoutCursor: 0,
    afterNoCursor: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    pruned: 3,
    after: [3, 5, 6, 7, 8, 9]
  })
})

it("prunes across scan pages and delete batches without skipping or deleting twice", async () => {
  const sessions = Array.from({ length: 2_600 }, (_, index) =>
    index % 97 === 0 || index % 89 === 0 ? undefined : `S${(index * 7) % 13}`
  )
  const events = sessions.map((session, index) => {
    if (session !== undefined) return activity(session)
    return index % 97 === 0 ? question : anonymous
  })
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const lifecycle = yield* SessionLifecycleEvents
      const base = (yield* readHeadSequence(sql, SESSION_LIFECYCLE_STREAM_ID)) ?? 0
      yield* sql.withTransaction(appendInTransaction(sql, SESSION_LIFECYCLE_STREAM_ID, events))
      yield* sql`DELETE FROM automation_trigger_cursor`
      yield* sql`INSERT INTO automation_trigger_cursor (stream_id, after_sequence)
          VALUES (${SESSION_LIFECYCLE_STREAM_ID}, ${base + 2_100})`
      const pruned = yield* lifecycle.pruneSupersededSnapshots()
      const again = yield* lifecycle.pruneSupersededSnapshots()
      const remaining = yield* sql<{ readonly sequence: number }>`
          SELECT sequence FROM journal_records
          WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID} AND sequence > ${base}
          ORDER BY sequence`
      return { pruned, again, remaining: remaining.map((row) => row.sequence - base) }
    })
  )
  const lastOf = new Map(
    sessions.flatMap((session, index) => (session === undefined ? [] : [[session, index] as const]))
  )
  const expected = sessions.flatMap((session, index) =>
    session !== undefined && index + 1 <= 2_100 && lastOf.get(session) !== index ? [] : [index + 1]
  )
  expect(outcome.remaining).toEqual(expected)
  expect(outcome.pruned).toBe(sessions.length - expected.length)
  expect(outcome.pruned).toBeGreaterThan(1_000)
  expect(outcome.again).toBe(0)
})

it("prunes several retained Sessions in one pass, each below its own boundary and newest snapshot", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const events = yield* SessionLifecycleEvents
      const base = (yield* readHeadSequence(sql, SESSION_LIFECYCLE_STREAM_ID)) ?? 0
      yield* sql.withTransaction(
        appendInTransaction(sql, SESSION_LIFECYCLE_STREAM_ID, [
          activity("A"),
          activity("B"),
          question,
          activity("A"),
          activity("C"),
          activity("B"),
          activity("A"),
          activity("C")
        ])
      )
      const pruned = yield* events.pruneSessionHistory([
        { sessionId: "A", retainedSequence: base + 7 },
        { sessionId: "B", retainedSequence: base + 6 }
      ])
      const rows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM journal_records
        WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID} AND sequence > ${base}
        ORDER BY sequence`
      return { pruned, after: rows.map((row) => row.sequence - base) }
    })
  )
  expect(outcome).toEqual({ pruned: 3, after: [3, 5, 6, 7, 8] })
})
