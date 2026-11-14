import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { MemoryCaptureStore } from "../src/persistence/memory/store.js"
import {
  memoryCaptureBacklogBackfill,
  TYPED_TURN
} from "../src/persistence/sqlite/memory-capture-backlog-backfill.js"
import { listCaptureWork } from "../src/persistence/sqlite/memory-capture-positions.js"
import {
  locateReplayCopy,
  rollBackOnReplayCopy,
  rolledBack,
  runOnReplayCopy
} from "./fixtures/replay-copy.js"

// Capture positions over the real history, with no model. The copy is opened the way the
// server opens it, so migration 0155 runs on it. The backfill and every appended turn then run
// through rollBackOnReplayCopy, so the old marks stay for the next run. Only counts leave this
// file.

const located = locateReplayCopy()

const OWNER = "session.session_type = 'chat' AND session.origin_automation_id IS NULL"

/** The header the old Capture wrote before each excerpt in its prompt. */
const EXCERPTS = /\[(?:user|assistant); sequence (\d+); characters \d+-\d+; /gu

it("reads every owner turn from its position, and keeps every old unread turn countable, on the real history", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const migrated = await runOnReplayCopy(
    located.copy,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const captures = yield* MemoryCaptureStore
      const [chats] = yield* sql<{ readonly owner: number; readonly positions: number }>`SELECT
        (SELECT COUNT(*) FROM sessions AS session WHERE ${sql.literal(OWNER)}) AS owner,
        (SELECT COUNT(*) FROM memory_capture_positions AS position
          JOIN sessions AS session ON session.session_id = position.session_id
          WHERE ${sql.literal(OWNER)}) AS positions`
      return { chats, work: (yield* captures.listWork(100)).length }
    })
  )
  const replayed = await rollBackOnReplayCopy(located.copy, replay)
  // Vitest swallows console output; a direct write reaches the terminal.
  process.stdout.write(
    `Replay: ${migrated.chats?.owner} owner chats, ${migrated.chats?.positions} positions, ` +
      `${migrated.work} listed after the update. ` +
      `Backfill: ${replayed.marksBefore} marks before, ${replayed.marksAfter} after; ` +
      `${replayed.sidecars.before} sidecar rows before, ${replayed.sidecars.after} after; ` +
      `${replayed.backlog.ranges} ranges. Excerpts in finished Capture prompts ` +
      `${replayed.excerpts}. Typed owner turns at or below a position: ` +
      `${replayed.partition.messages}; handed to a finished run ${replayed.partition.read}, ` +
      `branch copies ${replayed.partition.copies}, in a range ${replayed.partition.backlog}, ` +
      `in a range and read or copied ${replayed.partition.both}, in neither ${replayed.partition.neither}. ` +
      `Unread typed turns before the first mark ${replayed.backlog.before.typedTurns} ` +
      `(expected ${replayed.expected.before}) in ${replayed.backlog.before.chats} chats, ` +
      `since ${replayed.backlog.since.typedTurns} (expected ${replayed.expected.since}) ` +
      `in ${replayed.backlog.since.chats} chats; unread typed turns that are branch copies ` +
      `${replayed.expected.copies}; inside a finished batch but never quoted ` +
      `${replayed.expected.unquoted}. A new turn lists ${replayed.listed} of ${replayed.chats} owner chats from ` +
      `their position.\n`
  )
  expect(migrated).toEqual({
    chats: { owner: migrated.chats?.owner, positions: migrated.chats?.owner },
    work: 0
  })
  expect({
    marksAfter: replayed.marksAfter,
    both: replayed.partition.both,
    neither: replayed.partition.neither,
    before: replayed.backlog.before.typedTurns,
    since: replayed.backlog.since.typedTurns,
    listed: replayed.listed
  }).toEqual({
    marksAfter: 0,
    both: 0,
    neither: 0,
    before: replayed.expected.before,
    since: replayed.expected.since,
    listed: replayed.chats
  })
}, 1_800_000)

const replay = Effect.fn("replay")(function* (sql: SqlClient.SqlClient) {
  const [first] = yield* sql<{ readonly at: string; readonly marks: number }>`
    SELECT MIN(updated_at) AS at, COUNT(*) AS marks FROM run_sidecars
    WHERE json_type(evidence_json, '$.memory_capture') = 'object'`
  if (first === undefined) throw new Error("The copy holds no Capture marks")
  // What Capture read, rebuilt here apart from the backfill: every excerpt header in the prompt
  // of a finished old Capture run names a message it was shown. The old marks are not used.
  // As a cross-check, the turns inside a finished batch's start and end that its prompt never
  // quoted are counted too.
  const prompts = yield* sql<{
    readonly run_id: string
    readonly session_id: string
    readonly started_at: string
    readonly prompt: string
  }>`
    SELECT run.run_id,
      json_extract(run.metadata_json, '$.memory_capture_batch.sessionId') AS session_id,
      run.started_at, prompt.message_json AS prompt
    FROM chat_runs AS run
    JOIN session_turns AS turn ON turn.session_id = run.session_id
      AND turn.turn_id = json_extract(run.metadata_json, '$.turn_id')
    JOIN session_messages AS prompt ON prompt.session_id = turn.session_id
      AND prompt.message_id = turn.user_message_id
    WHERE run.status = 'completed'
      AND json_type(run.metadata_json, '$.memory_capture_batch.end.offset') = 'integer'`
  yield* sql`CREATE TEMP TABLE replay_excerpts
    (run_id TEXT, session_id TEXT, seq INTEGER, started_at TEXT)`
  let excerpts = 0
  for (const prompt of prompts) {
    for (const match of prompt.prompt.matchAll(EXCERPTS)) {
      yield* sql`INSERT INTO replay_excerpts VALUES
        (${prompt.run_id}, ${prompt.session_id}, ${Number(match[1])}, ${prompt.started_at})`
      excerpts += 1
    }
  }
  yield* sql`CREATE INDEX replay_excerpts_seq ON replay_excerpts (session_id, seq)`
  yield* sql`CREATE TEMP TABLE replay_batches AS
    SELECT run.run_id, json_extract(run.metadata_json, '$.memory_capture_batch.sessionId') AS session_id,
      run.started_at,
      CASE json_extract(run.metadata_json, '$.memory_capture_batch.start._tag')
        WHEN 'AfterSequence' THEN json_extract(run.metadata_json, '$.memory_capture_batch.start.sequence') + 1
        WHEN 'AtPosition' THEN json_extract(run.metadata_json, '$.memory_capture_batch.start.progress.sequence')
        ELSE (SELECT MIN(seq) FROM replay_excerpts AS excerpt WHERE excerpt.run_id = run.run_id)
      END AS from_seq,
      json_extract(run.metadata_json, '$.memory_capture_batch.end.sequence') AS through_seq
    FROM chat_runs AS run
    WHERE run.status = 'completed'
      AND json_type(run.metadata_json, '$.memory_capture_batch.end.offset') = 'integer'`
  yield* sql`CREATE TEMP TABLE replay_messages AS
    SELECT message.session_id, message.seq, message.message_id, message.created_at,
      EXISTS (SELECT 1 FROM replay_excerpts AS excerpt
        WHERE excerpt.session_id = message.session_id AND excerpt.seq = message.seq
          AND message.created_at <= excerpt.started_at) AS read,
      EXISTS (SELECT 1 FROM session_messages AS source
        WHERE source.session_id = json_extract(session.metadata, '$.fork_origin.sourceSessionId')
          AND source.message_id = message.message_id) AS copy
    FROM session_messages AS message
    JOIN sessions AS session ON session.session_id = message.session_id
    JOIN memory_capture_positions AS position ON position.session_id = message.session_id
    WHERE ${sql.literal(OWNER)} AND message.seq <= position.read_seq AND message.role = 'user'
      AND json_extract(message.message_json, '$.is_meta') IS NULL
      AND EXISTS (SELECT 1 FROM session_turns AS turn WHERE turn.session_id = message.session_id
        AND turn.user_message_id = message.message_id)`
  const [expected] = yield* sql<{
    readonly before: number
    readonly since: number
    readonly copies: number
    readonly unquoted: number
  }>`
    WITH typed AS (
      SELECT read, copy, created_at < ${first.at} AS before FROM replay_messages
    )
    SELECT
      (SELECT COUNT(*) FROM typed WHERE read = 0 AND copy = 0 AND before = 1) AS before,
      (SELECT COUNT(*) FROM typed WHERE read = 0 AND copy = 0 AND before = 0) AS since,
      (SELECT COUNT(*) FROM typed WHERE read = 0 AND copy = 1) AS copies,
      (SELECT COUNT(*) FROM replay_messages AS message
        WHERE message.read = 0 AND message.copy = 0
          AND EXISTS (SELECT 1 FROM replay_batches AS batch
            WHERE batch.session_id = message.session_id
              AND message.seq BETWEEN batch.from_seq AND batch.through_seq
              AND message.created_at <= batch.started_at)) AS unquoted`
  const sidecarRows = sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM run_sidecars`
  const [sidecarsBefore] = yield* sidecarRows
  for (let cursor: string | undefined = undefined, rounds = 0; rounds < 10_000; rounds += 1) {
    const chunk: { readonly next: string | undefined } = yield* memoryCaptureBacklogBackfill
      .chunk({ cursor, limit: 200 })
      .pipe(Effect.provideService(SqlClient.SqlClient, sql))
    cursor = chunk.next
    if (cursor === undefined) break
  }
  const [marksAfter] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
    FROM run_sidecars WHERE json_type(evidence_json, '$.memory_capture') IS NOT NULL`
  const [partition] = yield* sql<{
    readonly messages: number
    readonly read: number
    readonly copies: number
    readonly backlog: number
    readonly both: number
    readonly neither: number
  }>`
    WITH placed AS (
      SELECT message.read, message.copy,
        EXISTS (SELECT 1 FROM memory_capture_backlog AS backlog
          WHERE backlog.session_id = message.session_id
            AND message.seq BETWEEN backlog.from_seq AND backlog.through_seq) AS ranged
      FROM replay_messages AS message
    )
    SELECT COUNT(*) AS messages, SUM(read) AS read, SUM(copy) AS copies, SUM(ranged) AS backlog,
      SUM(ranged = 1 AND (read = 1 OR copy = 1)) AS both,
      SUM(ranged = 0 AND read = 0 AND copy = 0) AS neither
    FROM placed`
  const [sidecarsAfter] = yield* sidecarRows
  const parts = yield* sql<{
    readonly before: number
    readonly chats: number
    readonly typed_turns: number
  }>`
    SELECT message.created_at < ${first.at} AS before,
           COUNT(DISTINCT message.session_id) AS chats,
           SUM(${sql.literal(TYPED_TURN)}) AS typed_turns
    FROM memory_capture_backlog AS backlog
    JOIN session_messages AS message ON message.session_id = backlog.session_id
      AND message.seq BETWEEN backlog.from_seq AND backlog.through_seq
    GROUP BY before`
  const [ranges] = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM memory_capture_backlog`
  const part = (before: 0 | 1) => {
    const row = parts.find((candidate) => candidate.before === before)
    return { chats: row?.chats ?? 0, typedTurns: row?.typed_turns ?? 0 }
  }
  const backlog = { ranges: ranges?.count ?? 0, before: part(1), since: part(0) }
  const chats = yield* sql<{ readonly session_id: string; readonly next_seq: number }>`
    SELECT session.session_id,
      COALESCE((SELECT MAX(seq) + 1 FROM session_messages
        WHERE session_id = session.session_id), 0) AS next_seq
    FROM sessions AS session WHERE ${sql.literal(OWNER)}`
  let listed = 0
  for (const chat of chats) {
    const work = yield* rolledBack(
      sql,
      Effect.gen(function* () {
        yield* sql`INSERT INTO session_messages
          (session_id, message_id, seq, role, message_json, created_at, search_text)
          VALUES (${chat.session_id}, 'replay-turn', ${chat.next_seq}, 'user',
            ${JSON.stringify({
              message_id: "replay-turn",
              role: "user",
              content: "replay",
              created_at: "2026-11-14T00:00:00.000Z"
            })}, '2026-11-14T00:00:00.000Z', 'replay')`
        return yield* listCaptureWork(sql, 100)
      })
    )
    const stored = yield* sql<{ readonly read_seq: number }>`SELECT read_seq
      FROM memory_capture_positions WHERE session_id = ${chat.session_id}`
    const own = work.find((item) => item.sessionId === chat.session_id)
    const from = stored[0]?.read_seq ?? -1
    if (
      own !== undefined &&
      own.throughSequence === chat.next_seq &&
      (from < 0
        ? own.position._tag === "Beginning"
        : own.position._tag === "AfterSequence" && own.position.sequence === from)
    )
      listed += 1
  }
  return {
    marksBefore: first.marks,
    excerpts,
    marksAfter: marksAfter?.count,
    partition: partition ?? { messages: 0, read: 0, copies: 0, backlog: 0, both: 0, neither: 0 },
    expected: expected ?? { before: 0, since: 0, copies: 0, unquoted: 0 },
    backlog,
    sidecars: { before: sidecarsBefore?.count, after: sidecarsAfter?.count },
    chats: chats.length,
    listed
  }
})
