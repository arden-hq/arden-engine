import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { appendInTransaction, readHeadSequence } from "@arden-hq/journal/effect"
import { expect, it } from "vitest"
import { makeWriter } from "../src/persistence/sqlite/deps.js"
import { trimJournals } from "../src/persistence/sqlite/journal-retention.js"
import { readLatestRunBoundary } from "../src/persistence/sqlite/journal-run-boundary.js"
import { SESSION_LIFECYCLE_STREAM_ID } from "../src/persistence/sessions/events.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const DAY = 86_400_000
const NOW = Date.now()
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
const event = (type: string, runId?: string) => ({
  type,
  data: { type },
  ...(runId === undefined ? {} : { attributes: { runId } })
})

it("lifecycle rule deletes only old status rows the trigger listener has read", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const writer = makeWriter({ sql, reader: sql, queue: yield* PersistenceWriteQueue })
      const base = (yield* readHeadSequence(sql, SESSION_LIFECYCLE_STREAM_ID)) ?? 0
      const bulk = Array.from({ length: 4_100 }, () => event("automation_progress"))
      const mixed = [
        event("automation_finished"),
        event("automation_queued"),
        event("question_changed"),
        event("session_activity"),
        event("automation_progress"),
        event("automation_progress"),
        event("automation_finished")
      ]
      yield* sql.withTransaction(
        appendInTransaction(sql, SESSION_LIFECYCLE_STREAM_ID, [...bulk, ...mixed])
      )
      yield* sql`UPDATE journal_records SET created_at = ${ago(10)}
        WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID} AND sequence > ${base}`
      const setCursor = (offset: number) =>
        sql`DELETE FROM automation_trigger_cursor`.pipe(
          Effect.andThen(
            sql`INSERT INTO automation_trigger_cursor (stream_id, after_sequence)
              VALUES (${SESSION_LIFECYCLE_STREAM_ID}, ${base + offset})`
          )
        )
      const trim = () =>
        trimJournals({
          writer,
          policy: {
            retention: () =>
              Effect.succeed({
                agentTrace: { kind: "forever" },
                wikiHistory: { kind: "forever" }
              } as const)
          }
        })
      const kept = () =>
        sql<{ readonly sequence: number }>`
          SELECT sequence FROM journal_records
          WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID} AND sequence > ${base}
          ORDER BY sequence`.pipe(
          Effect.map((rows) =>
            rows.filter((row) => row.sequence - base > 4_100).map((row) => row.sequence - base)
          )
        )
      const floorBefore = yield* sql`SELECT retained_from_sequence AS floor FROM journal_streams
        WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}`
      yield* setCursor(4_105)
      const readOnly = yield* trim()
      const keptReadOnly = yield* kept()
      const floorAfter = yield* sql`SELECT retained_from_sequence AS floor FROM journal_streams
        WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}`
      yield* setCursor(4_107)
      const headStays = yield* trim()
      const keptHead = yield* kept()
      yield* sql.withTransaction(
        appendInTransaction(sql, SESSION_LIFECYCLE_STREAM_ID, [event("automation_progress")])
      )
      yield* setCursor(4_108)
      const recentStays = yield* trim()
      const keptRecent = yield* kept()
      return {
        readOnly,
        keptReadOnly,
        floorMoved: JSON.stringify(floorBefore) !== JSON.stringify(floorAfter),
        headStays,
        keptHead,
        recentStays,
        keptRecent
      }
    }).pipe(Effect.provide(PersistenceWriteQueue.layer))
  )
  expect(outcome).toEqual({
    readOnly: { lifecycle: 4_103, sessions: 0 },
    keptReadOnly: [4_103, 4_104, 4_106, 4_107],
    floorMoved: false,
    headStays: { lifecycle: 1, sessions: 0 },
    keptHead: [4_103, 4_104, 4_107],
    recentStays: { lifecycle: 0, sessions: 0 },
    keptRecent: [4_103, 4_104, 4_107, 4_108]
  })
})

it("session rule walks old rows once: step rows of free runs and no-run rows go; boundary rows, pinned runs and heads stay", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const writer = makeWriter({ sql, reader: sql, queue: yield* PersistenceWriteQueue })
      const policy = {
        retention: () =>
          Effect.succeed({
            agentTrace: { kind: "days", days: 30 },
            wikiHistory: { kind: "forever" }
          } as const)
      }
      const session = (id: string) =>
        sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type)
          VALUES (${id}, ${`chat~${id}`}, ${ago(60)}, ${ago(60)}, 'chat')`
      const run = (id: string, sessionId: string, status: string, endedDaysAgo: number | null) =>
        sql`INSERT INTO chat_runs (run_id, session_id, status, stop_reason, started_at, updated_at,
            ended_at, assistant_message_id)
          VALUES (${id}, ${sessionId}, ${status},
            ${status === "interrupted" ? "server_restart" : null}, ${ago(60)},
            ${endedDaysAgo === null ? ago(60) : ago(endedDaysAgo)},
            ${endedDaysAgo === null ? null : ago(endedDaysAgo)}, ${`assistant-${id}`})`
      const append = (streamId: string, events: ReadonlyArray<ReturnType<typeof event>>) =>
        sql.withTransaction(appendInTransaction(sql, streamId, events))
      // A: an active run sits between two old finished runs.
      // Old rows: 1 no-run, 2..4503 r1 (4,500 steps), 4504..4506 r2 (active),
      // 4507..4508 r3, 4509 no-run. Then r4 (recent) 4510..4511, the head.
      yield* session("A")
      yield* run("r1", "A", "completed", 50)
      yield* run("r2", "A", "running", null)
      yield* run("r3", "A", "interrupted", 48)
      yield* run("r4", "A", "completed", 1)
      yield* append("A", [
        event("NOTE"),
        event("RUN_STARTED", "r1"),
        ...Array.from({ length: 4_500 }, () => event("TEXT", "r1")),
        event("RUN_FINISHED", "r1"),
        event("RUN_STARTED", "r2"),
        event("TEXT", "r2"),
        event("RUN_FINISHED", "r2"),
        event("RUN_STARTED", "r3"),
        event("RUN_FINISHED", "r3"),
        event("NOTE")
      ])
      // B: an old finished run: its step row goes, the head stays.
      yield* session("B")
      yield* run("rb", "B", "completed", 50)
      yield* append("B", [
        event("RUN_STARTED", "rb"),
        event("TEXT", "rb"),
        event("RUN_FINISHED", "rb")
      ])
      // C: a running run is live work, yet the old finished run is trimmed.
      yield* session("C")
      yield* run("rc1", "C", "completed", 50)
      yield* run("rc2", "C", "running", null)
      yield* append("C", [
        event("RUN_STARTED", "rc1"),
        event("TEXT", "rc1"),
        event("RUN_FINISHED", "rc1"),
        event("RUN_STARTED", "rc2")
      ])
      // D: an old active run, then an old ended run, then a
      // recent run. Event admission reads the newest boundary row at or below
      // the checkpoint (5): it must still be the ended run's RUN_FINISHED.
      yield* session("D")
      yield* run("rp", "D", "running", null)
      yield* run("rx", "D", "completed", 49)
      yield* run("rz", "D", "completed", 1)
      yield* append("D", [
        event("RUN_STARTED", "rp"),
        event("TEXT", "rp"),
        event("RUN_STARTED", "rx"),
        event("TEXT", "rx"),
        event("RUN_FINISHED", "rx")
      ])
      // A row above the checkpoint stays, whatever it is.
      yield* session("F")
      yield* run("rf", "F", "completed", 50)
      yield* append("F", [
        event("RUN_STARTED", "rf"),
        event("TEXT", "rf"),
        event("TEXT", "rf"),
        event("RUN_FINISHED", "rf")
      ])
      // E: step rows of a run missing from `chat_runs` are not pinned: they go.
      // They are the last old rows, so the saved cursor will name a deleted row.
      yield* session("E")
      yield* append("E", [event("TEXT", "ghost"), event("TEXT", "ghost")])
      yield* sql`UPDATE journal_records SET created_at = ${ago(50)}`
      // The recent rows come last, as they would in a real journal.
      yield* append("A", [event("RUN_STARTED", "r4"), event("RUN_FINISHED", "r4")])
      yield* append("D", [event("RUN_STARTED", "rz")])
      yield* append("E", [event("NOTE")])
      yield* sql`UPDATE journal_records SET created_at = ${ago(1)} WHERE created_at > ${ago(2)}`
      // Clients have resumed past every old row, except in D, whose checkpoint is 5.
      yield* sql`INSERT INTO session_event_checkpoints (session_id, checkpoint_seq)
        VALUES ('A', 10000), ('B', 10000), ('C', 10000), ('D', 5), ('E', 10000), ('F', 2)`

      const rows = (streamId: string) =>
        sql<{ readonly sequence: number }>`
          SELECT sequence FROM journal_records WHERE stream_id = ${streamId} ORDER BY sequence`.pipe(
          Effect.map((found) => found.map((row) => row.sequence))
        )
      const flags = () =>
        sql<{ readonly run_id: string; readonly removed: number }>`
          SELECT run_id, json_extract(metadata_json, '$.trace_removed_at') IS NOT NULL AS removed
          FROM chat_runs ORDER BY run_id`.pipe(
          Effect.map((found) => found.map((f) => [f.run_id, f.removed === 1]))
        )
      const held = () =>
        sql<{
          readonly run_id: string
          readonly stream_id: string
          readonly from_sequence: number
          readonly through_sequence: number
        }>`SELECT * FROM journal_retention_held ORDER BY run_id`.pipe(
          Effect.map((found) =>
            found.map((h) => [h.run_id, h.stream_id, h.from_sequence, h.through_sequence])
          )
        )
      const cursors = () =>
        sql<{ readonly name: string; readonly stream_id: string; readonly sequence: number }>`
          SELECT name, stream_id, sequence FROM journal_retention_cursors ORDER BY name`.pipe(
          Effect.map((found) => found.map((c) => [c.name, c.stream_id, c.sequence]))
        )

      const result = yield* trimJournals({ writer, policy })
      const admission = yield* readLatestRunBoundary(sql, "D")
      const first = {
        a: yield* rows("A"),
        b: yield* rows("B"),
        c: yield* rows("C"),
        d: yield* rows("D"),
        flags: yield* flags(),
        held: yield* held(),
        cursors: yield* cursors(),
        f: yield* rows("F"),
        e: yield* rows("E")
      }
      // Everything is now old, and B has two new rows. The saved cursor names a
      // deleted row; the walk resumes after it and reaches them.
      yield* append("B", [event("TEXT", "rb"), event("TEXT", "rb")])
      yield* sql`UPDATE journal_records SET created_at = ${ago(50)}`
      const again = yield* trimJournals({ writer, policy })
      // The run ends long ago: its step rows go on the next tick.
      yield* sql`UPDATE chat_runs SET status = 'completed', ended_at = ${ago(49)},
        updated_at = ${ago(49)} WHERE run_id = 'rp'`
      const released = yield* trimJournals({ writer, policy })
      const settled = yield* trimJournals({ writer, policy })
      return {
        result,
        admission: admission.map((row) => [row.event_type, row.run_id]),
        first,
        again,
        released,
        settled,
        dAfter: yield* rows("D"),
        heldAfter: yield* held(),
        flagsAfter: yield* flags()
      }
    }).pipe(Effect.provide(PersistenceWriteQueue.layer))
  )
  const allA = [2, 4_503, 4_504, 4_505, 4_506, 4_507, 4_508, 4_510, 4_511]
  expect(outcome).toEqual({
    // A: r1's 4,500 step rows and two no-run rows; one step row each for B, C and D.
    result: { lifecycle: 0, sessions: 4_502 + 1 + 1 + 1 + 1 + 2 },
    admission: [["RUN_FINISHED", "rx"]],
    first: {
      a: allA,
      b: [1, 3],
      c: [1, 3, 4],
      d: [1, 2, 3, 5, 6],
      flags: [
        ["r1", true],
        ["r2", false],
        ["r3", false],
        ["r4", false],
        ["rb", true],
        ["rc1", true],
        ["rc2", false],
        ["rf", true],
        ["rp", false],
        ["rx", true],
        ["rz", false]
      ],
      held: [
        ["r2", "A", 4_505, 4_505],
        ["rp", "D", 2, 2]
      ],
      cursors: [["session_steps", "E", 2]],
      f: [1, 3, 4],
      e: [3]
    },
    again: { lifecycle: 0, sessions: 1 },
    released: { lifecycle: 0, sessions: 1 },
    settled: { lifecycle: 0, sessions: 0 },
    dAfter: [1, 3, 5, 6],
    heldAfter: [["r2", "A", 4_505, 4_505]],
    flagsAfter: [
      ["r1", true],
      ["r2", false],
      ["r3", false],
      ["r4", false],
      ["rb", true],
      ["rc1", true],
      ["rc2", false],
      ["rf", true],
      ["rp", true],
      ["rx", true],
      ["rz", false]
    ]
  })
})
