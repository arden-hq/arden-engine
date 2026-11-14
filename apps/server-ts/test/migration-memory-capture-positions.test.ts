import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"
import { MemoryCaptureStore } from "../src/persistence/memory/store.js"
import { memoryCaptureBacklogBackfill } from "../src/persistence/sqlite/memory-capture-backlog-backfill.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"

// The update puts every owner chat at its last message, so nothing old is read, and keeps the
// old unread messages as ranges that can be counted. Branch copies are not counted twice. A
// turn counts as read only if a finished Capture run quoted it, whatever the old marks say.

const BEFORE_POSITIONS = 154
const AT = "2026-10-01T09:00:00.000Z"
const LATER = "2026-10-01T10:00:00.000Z"
const COHORT_TURNS = 10

const seed = (database: DatabaseSync): void => {
  const session = database.prepare(`INSERT INTO sessions
    (session_id, public_ref, started_at, last_activity, origin_automation_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?)`)
  session.run("owner", "owner-ref", AT, AT, null, null)
  session.run(
    "branch",
    "branch-ref",
    AT,
    AT,
    null,
    JSON.stringify({ fork_origin: { sourceSessionId: "owner" } })
  )
  session.run("automation", "automation-ref", AT, AT, "builtin-daily", null)
  session.run("cohort", "cohort-ref", AT, AT, null, null)
  const message = database.prepare(`INSERT INTO session_messages
    (session_id, message_id, seq, role, message_json, created_at, search_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const turn = database.prepare(`INSERT INTO session_turns
    (session_id, turn_id, turn_index, user_message_id, message_start_id, message_end_id,
      message_start_seq, message_end_seq, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const run = database.prepare(`INSERT INTO chat_runs
    (run_id, session_id, status, started_at, updated_at, ended_at, assistant_message_id)
    VALUES (?, ?, 'completed', ?, ?, ?, ?)`)
  const mark =
    database.prepare(`INSERT INTO run_sidecars (run_id, session_id, evidence_json, updated_at)
    VALUES (?, ?, ?, ?)`)
  const write = (chat: string, seq: number, id: string, role: "user" | "assistant") =>
    message.run(
      chat,
      id,
      seq,
      role,
      JSON.stringify({ message_id: id, role, content: id, created_at: AT }),
      AT,
      id
    )
  const pairs: ReadonlyArray<readonly [chat: string, user: string, answer: string]> = [
    ["owner", "u1", "a1"],
    ["owner", "u2", "a2"],
    ["owner", "u3", "a3"],
    ["branch", "u1", "a1"],
    ...Array.from(
      { length: COHORT_TURNS },
      (_, index) => ["cohort", `c${index}`, `d${index}`] as const
    ),
    ["branch", "own", "own-answer"],
    ["automation", "job", "job-answer"]
  ]
  const next = new Map<string, number>()
  for (const [chat, user, answer] of pairs) {
    const seq = next.get(chat) ?? 0
    write(chat, seq, user, "user")
    write(chat, seq + 1, answer, "assistant")
    turn.run(chat, `${chat}-${user}`, seq / 2, user, user, answer, seq, seq + 1, AT, AT)
    run.run(`${chat}-${answer}`, chat, AT, AT, AT, answer)
    next.set(chat, seq + 2)
  }
  const capture = (status: string, generation: number, through: number) =>
    JSON.stringify({
      memory_capture: { status, context_generation: generation, through_sequence: through }
    })
  // The first turn was read. The two after it were marked and never read, the last one after a
  // compaction that stored its context number as a decimal.
  mark.run("owner-a1", "owner", capture("done", 0, 1), AT)
  mark.run("owner-a2", "owner", capture("pending", 0, 3), AT)
  mark.run("owner-a3", "owner", capture("pending", 1.5, 5), AT)
  mark.run("automation-job-answer", "automation", capture("pending", 0, 1), AT)
  // The old Capture settled all ten waiting marks of this chat with one batch, which read only
  // its latest records. Every mark says done, but the first three turns were never read.
  for (let index = 0; index < COHORT_TURNS; index += 1)
    mark.run(`cohort-d${index}`, "cohort", capture("done", 0, index * 2 + 1), AT)
  session.run("capture", "capture-ref", AT, AT, "builtin-memory-capture", null)
  const captureRun = database.prepare(`INSERT INTO chat_runs
    (run_id, session_id, status, started_at, updated_at, ended_at, assistant_message_id,
      metadata_json)
    VALUES (?, 'capture', ?, ?, ?, ?, ?, ?)`)
  const handed = (chat: string, turnId: string, excerpts: ReadonlyArray<number>) => {
    const prompt = `prompt-${turnId}`
    const seq = next.get("capture") ?? 0
    const lines = excerpts.map(
      (excerpt) => `> [user; sequence ${excerpt}; characters 1-2; Human source] x`
    )
    message.run(
      "capture",
      prompt,
      seq,
      "user",
      JSON.stringify({
        message_id: prompt,
        role: "user",
        turn_id: turnId,
        content: [`Chat ${chat}`, ...lines].join("\n"),
        created_at: LATER
      }),
      LATER,
      prompt
    )
    turn.run("capture", turnId, seq, prompt, prompt, prompt, seq, seq, LATER, LATER)
    next.set("capture", seq + 1)
  }
  const ran = (
    runId: string,
    status: string,
    batch: { readonly sessionId: string; readonly start: object; readonly end: number }
  ) =>
    captureRun.run(
      runId,
      status,
      LATER,
      LATER,
      LATER,
      `answer-${runId}`,
      JSON.stringify({
        turn_id: runId,
        memory_capture_batch: {
          sessionId: batch.sessionId,
          contextGeneration: 0,
          start: batch.start,
          end: { sequence: batch.end, offset: 2 }
        }
      })
    )
  handed("owner", "capture-owner", [0, 1])
  ran("capture-owner", "completed", { sessionId: "owner", start: { _tag: "Beginning" }, end: 1 })
  handed("cohort", "capture-cohort", [6, 7, 8])
  ran("capture-cohort", "completed", { sessionId: "cohort", start: { _tag: "Beginning" }, end: 8 })
  // The next batch ran to the end, but its prompt never quoted one turn, so that turn stays.
  handed(
    "cohort",
    "capture-cohort-rest",
    Array.from({ length: COHORT_TURNS * 2 - 8 }, (_, index) => index + 8).filter(
      (seq) => seq !== 12
    )
  )
  ran("capture-cohort-rest", "completed", {
    sessionId: "cohort",
    start: { _tag: "AtPosition", progress: { sequence: 8, offset: 2 } },
    end: COHORT_TURNS * 2 - 1
  })
  // A failed run quoted the owner's second turn, so that turn was not read.
  handed("owner", "capture-failed", [2, 3])
  ran("capture-failed", "error", {
    sessionId: "owner",
    start: { _tag: "AfterSequence", sequence: 1 },
    end: 3
  })
}

const migrateTo154 = (filename: string): void => {
  const database = new DatabaseSync(filename)
  try {
    for (const statement of baselineStatements) database.exec(statement)
    database.exec("PRAGMA user_version = 1")
    for (const step of pendingMigrationSteps(
      { kind: "pending", from: 1, bridge: undefined },
      migrations.filter((entry) => entry.version <= BEFORE_POSITIONS)
    ))
      step.run(database)
    database.exec("PRAGMA foreign_keys = ON")
    seed(database)
  } finally {
    database.close()
  }
}

it("starts each owner chat at its last message and keeps old unread messages countable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-capture-positions-"))
  const filename = join(directory, "arden.db")
  try {
    migrateTo154(filename)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const captures = yield* MemoryCaptureStore
        const positions = yield* sql`SELECT session_id, read_seq, read_offset, prepared_json
          FROM memory_capture_positions ORDER BY session_id`
        const workAfterUpdate = yield* captures.listWork()
        for (let cursor: string | undefined = undefined, rounds = 0; rounds < 10; rounds += 1) {
          const chunk: { readonly next: string | undefined } =
            yield* memoryCaptureBacklogBackfill.chunk({ cursor, limit: 2 })
          cursor = chunk.next
          if (cursor === undefined) break
        }
        const backlog = yield* sql`SELECT session_id, from_seq, through_seq
          FROM memory_capture_backlog ORDER BY session_id, from_seq`
        const marks = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM run_sidecars WHERE json_type(evidence_json, '$.memory_capture') IS NOT NULL`
        const count = yield* captures.backlogCount({ splitAt: "2026-12-01T00:00:00.000Z" })
        yield* sql`INSERT INTO session_messages
          (session_id, message_id, seq, role, message_json, created_at, search_text)
          VALUES ('owner', 'u4', 6, 'user', ${JSON.stringify({
            message_id: "u4",
            role: "user",
            content: "u4",
            created_at: AT
          })}, ${AT}, 'u4')`
        return {
          positions,
          workAfterUpdate,
          backlog,
          marks: marks[0]?.count,
          count,
          workAfterTurn: yield* captures.listWork()
        }
      }).pipe(
        Effect.provide(
          SqliteClient.layer({ filename }).pipe(
            Layer.provideMerge(
              sqlitePersistenceLayer({ dataDir: null, filename }).pipe(
                Layer.provide(PersistenceWriteQueue.layer)
              )
            )
          )
        )
      )
    )
    expect(result).toEqual({
      positions: [
        { session_id: "branch", read_seq: 3, read_offset: null, prepared_json: null },
        {
          session_id: "cohort",
          read_seq: COHORT_TURNS * 2 - 1,
          read_offset: null,
          prepared_json: null
        },
        { session_id: "owner", read_seq: 5, read_offset: null, prepared_json: null }
      ],
      workAfterUpdate: [],
      backlog: [
        { session_id: "branch", from_seq: 2, through_seq: 3 },
        { session_id: "cohort", from_seq: 0, through_seq: 5 },
        { session_id: "cohort", from_seq: 12, through_seq: 12 },
        { session_id: "owner", from_seq: 2, through_seq: 5 }
      ],
      marks: 0,
      count: {
        ranges: 4,
        before: {
          chats: 3,
          typedTurns: 7,
          userCharacters: "u2u3ownc0c1c2c6".length,
          assistantCharacters: "a2a3own-answerd0d1d2".length,
          batches: 1
        },
        since: { chats: 0, typedTurns: 0, userCharacters: 0, assistantCharacters: 0, batches: 0 },
        freshTokensPerBatch: undefined
      },
      workAfterTurn: [
        {
          sessionId: "owner",
          position: { _tag: "AfterSequence", sequence: 5 },
          throughSequence: 6,
          prepared: undefined
        }
      ]
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
