import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { activeContextWindowOnly } from "../src/persistence/migrations/0175_active_context_window_only.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})

const STAMP = "2026-11-20T10:00:00.000Z"

const upTo = (database: DatabaseSync, from: number, last: number) => {
  for (const step of pendingMigrationSteps(
    { kind: "pending", from, bridge: undefined },
    migrations.filter((migration) => migration.version > from && migration.version <= last)
  ))
    step.run(database)
}

const envelope = (sessionId: string, seq: number) => ({
  message_id: `${sessionId}-${seq}`,
  role: "user",
  created_at: STAMP,
  content: "hello"
})

const seedChat = (
  database: DatabaseSync,
  sessionId: string,
  seqs: ReadonlyArray<number>,
  context: {
    readonly messages: string | null
    readonly count: number
    readonly from: number | null
  }
) => {
  database
    .prepare(
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type,
        messages, active_message_count, context_from_seq)
      VALUES (?, ?, ?, ?, 'chat', ?, ?, ?)`
    )
    .run(sessionId, `ref-${sessionId}`, STAMP, STAMP, context.messages, context.count, context.from)
  for (const seq of seqs) {
    database
      .prepare(
        `INSERT INTO session_messages (session_id, message_id, seq, role, message_json, created_at)
        VALUES (?, ?, ?, 'user', ?, ?)`
      )
      .run(sessionId, `${sessionId}-${seq}`, seq, JSON.stringify(envelope(sessionId, seq)), STAMP)
  }
}

const listing = (sessionId: string, entries: ReadonlyArray<number | string>) =>
  JSON.stringify(
    entries.map((entry) =>
      typeof entry === "number"
        ? envelope(sessionId, entry)
        : { ...envelope(sessionId, 0), message_id: entry }
    )
  )

it("turns every array active context into the window the staged backfill built", () => {
  const database = new DatabaseSync(":memory:")
  opened.push(database)
  for (const statement of baselineStatements) database.exec(statement)
  database.exec("PRAGMA user_version = 1")
  upTo(database, 1, activeContextWindowOnly.version - 1)

  seedChat(database, "listed", [0, 1, 2, 3, 4, 5, 6, 7], {
    messages: listing("listed", [5, 1, "gone", 2, 4]),
    count: 5,
    from: null
  })
  seedChat(database, "ordered", [0, 1, 2, 3], {
    messages: listing("ordered", [2, 3]),
    count: 2,
    from: null
  })
  seedChat(database, "empty", [0, 1, 2], { messages: "[]", count: 0, from: null })
  seedChat(database, "corrupt", [0, 1, 2], { messages: "{not json", count: 2, from: null })
  seedChat(database, "window", [0, 1, 2], { messages: null, count: 1, from: 1 })
  database.exec(`INSERT INTO session_context_hidden (session_id, seq)
    VALUES ('corrupt', 1), ('window', 2)`)
  database.exec(`INSERT INTO data_backfills (name, started_at, updated_at)
    VALUES ('active_context_window_staged', '${STAMP}', '${STAMP}')`)

  upTo(database, activeContextWindowOnly.version - 1, activeContextWindowOnly.version)

  expect(
    database
      .prepare(
        `SELECT session_id, context_from_seq, context_head_seq, active_message_count, messages
        FROM sessions ORDER BY session_id`
      )
      .all()
  ).toEqual([
    {
      session_id: "corrupt",
      context_from_seq: 3,
      context_head_seq: null,
      active_message_count: 0,
      messages: null
    },
    {
      session_id: "empty",
      context_from_seq: 3,
      context_head_seq: null,
      active_message_count: 0,
      messages: null
    },
    {
      session_id: "listed",
      context_from_seq: 1,
      context_head_seq: 5,
      active_message_count: 4,
      messages: null
    },
    {
      session_id: "ordered",
      context_from_seq: 2,
      context_head_seq: null,
      active_message_count: 2,
      messages: null
    },
    {
      session_id: "window",
      context_from_seq: 1,
      context_head_seq: null,
      active_message_count: 1,
      messages: null
    }
  ])
  expect(
    database
      .prepare("SELECT session_id, seq FROM session_context_hidden ORDER BY session_id, seq")
      .all()
  ).toEqual([
    { session_id: "listed", seq: 3 },
    { session_id: "listed", seq: 6 },
    { session_id: "listed", seq: 7 },
    { session_id: "window", seq: 2 }
  ])
  expect(database.prepare("SELECT name FROM data_backfills").all()).toEqual([])
  expect(
    database
      .prepare(
        "SELECT name FROM pragma_table_info('sessions') WHERE name = 'legacy_context_revision'"
      )
      .all()
  ).toEqual([])
})
