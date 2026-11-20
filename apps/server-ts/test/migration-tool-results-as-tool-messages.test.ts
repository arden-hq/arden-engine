import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { toolResultsAsToolMessages } from "../src/persistence/migrations/0176_tool_results_as_tool_messages.js"
import { migrations } from "../src/persistence/migrations/index.js"

const AT = "2026-11-20T00:00:00.000Z"
const IMAGE = { type: "image", media_type: "image/png", data: "iVBORw0KGgo" }
const call = (id: string) => ({
  id,
  type: "function",
  function: { name: "lookup", arguments: "{}" }
})
const mediaHeader = (id: string) => ({
  type: "context",
  content_type: "tool_result_media",
  content: "Media returned by tool lookup.",
  metadata: { tool_call_id: id, tool_name: "lookup" }
})

const migrated = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations.filter(
    (entry) => entry.version < toolResultsAsToolMessages.version
  ))
    migration.up(database)
  database.exec("PRAGMA foreign_keys = ON")
  return database
}

const seed = (database: DatabaseSync) => {
  database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
      active_message_count, visible_message_count, context_from_seq)
    VALUES ('lab', 'lab-ref', '${AT}', '${AT}', 10, 10, 0),
      ('edge', 'edge-ref', '${AT}', '${AT}', 4, 4, 0)`)
  const row = database.prepare(`INSERT INTO session_messages
      (session_id, message_id, seq, role, message_json, client_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '${AT}')`)
  const add = (
    session: string,
    seq: number,
    message: Record<string, unknown>,
    clientId: string | null = null
  ) =>
    row.run(
      session,
      String(message.message_id),
      seq,
      String(message.role),
      JSON.stringify({ ...message, turn_id: "t" }),
      clientId
    )
  add("lab", 0, { message_id: "u", role: "user", content: "Go" })
  add("lab", 1, {
    message_id: "a",
    role: "assistant",
    content: "",
    tool_calls: [call("sync"), call("bg"), { ...call("native"), async: true }]
  })
  add("lab", 2, { message_id: "r-sync", role: "tool", tool_call_id: "sync", content: "S out" })
  add(
    "lab",
    3,
    {
      message_id: "m-sync",
      role: "user",
      is_meta: true,
      client_id: "tool-media:sync",
      content: [mediaHeader("sync"), IMAGE]
    },
    "tool-media:sync"
  )
  add("lab", 4, {
    message_id: "async-launch:bg",
    role: "tool",
    tool_call_id: "bg",
    async_tool_launch: { call_id: "bg", delivery: "message" },
    content: "running"
  })
  add("lab", 5, {
    message_id: "async-launch:native",
    role: "user",
    is_meta: true,
    async_tool_launch: { call_id: "native", delivery: "native" },
    content: []
  })
  add("lab", 6, { message_id: "w", role: "assistant", content: "Waiting" })
  add(
    "lab",
    7,
    {
      message_id: "async-result:bg",
      role: "user",
      is_meta: true,
      client_id: "async-result:bg",
      content: [
        {
          type: "context",
          content_type: "async_tool_result",
          content: "B out",
          metadata: { tool_call_id: "bg", tool_name: "lookup" }
        }
      ]
    },
    "async-result:bg"
  )
  add(
    "lab",
    8,
    { message_id: "m-bg", role: "user", is_meta: true, content: [IMAGE] },
    "tool-media:bg"
  )
  add("lab", 9, { message_id: "r-native", role: "tool", tool_call_id: "native", content: "N out" })
  add("edge", 0, { message_id: "eu", role: "user", content: "Go" })
  add("edge", 1, { message_id: "ea", role: "assistant", content: "", tool_calls: [call("d")] })
  add("edge", 2, { message_id: "er", role: "tool", tool_call_id: "d", content: "D out" })
  add(
    "edge",
    3,
    {
      message_id: "em",
      role: "user",
      is_meta: true,
      client_id: "tool-media:d",
      content: [mediaHeader("d"), IMAGE]
    },
    "tool-media:d"
  )
  const turn = database.prepare(`INSERT INTO session_turns (session_id, turn_id, turn_index,
      user_message_id, message_start_id, message_end_id, message_start_seq, message_end_seq,
      started_at, ended_at) VALUES (?, 't', 0, ?, ?, ?, 0, ?, '${AT}', '${AT}')`)
  turn.run("lab", "u", "u", "r-native", 9)
  turn.run("edge", "eu", "eu", "em", 3)
  database.exec(`INSERT INTO chat_summaries (session_id, title, summary, through_sequence, updated_at)
    VALUES ('lab', 'Lab', 'Looked it up', 9, '${AT}')`)
}

it("migration 0176 stores every tool result as a tool message", () => {
  const database = migrated()
  seed(database)

  toolResultsAsToolMessages.up(database)

  const rows = (session: string) =>
    database
      .prepare(
        "SELECT seq, role, client_id, message_json FROM session_messages WHERE session_id = ? ORDER BY seq"
      )
      .all(session)
      .map((row) => {
        const { turn_id: _turn, ...message } = JSON.parse(String(row.message_json))
        return { seq: row.seq, role: row.role, client_id: row.client_id, message }
      })
  expect(rows("lab")).toEqual([
    expect.objectContaining({ seq: 0, role: "user" }),
    expect.objectContaining({ seq: 1, role: "assistant" }),
    {
      seq: 2,
      role: "tool",
      client_id: null,
      message: {
        message_id: "r-sync",
        role: "tool",
        tool_call_id: "sync",
        content: "S out",
        model_content: [IMAGE]
      }
    },
    {
      seq: 4,
      role: "tool",
      client_id: null,
      message: {
        message_id: "async-launch:bg",
        role: "tool",
        tool_call_id: "bg",
        async_tool_launch: { call_id: "bg" },
        content: "running"
      }
    },
    {
      seq: 5,
      role: "tool",
      client_id: null,
      message: {
        message_id: "async-launch:native",
        role: "tool",
        tool_call_id: "native",
        async_tool_launch: { call_id: "native" },
        content: JSON.stringify({
          status: "running",
          tool_call_id: "native",
          instruction: "The result will arrive in an internal completion message."
        })
      }
    },
    expect.objectContaining({ seq: 6, role: "assistant" }),
    {
      seq: 7,
      role: "tool",
      client_id: null,
      message: {
        message_id: "async-result:bg",
        role: "tool",
        tool_call_id: "bg",
        content: "B out",
        model_content: [IMAGE]
      }
    },
    expect.objectContaining({ seq: 9, role: "tool" })
  ])
  expect(rows("edge").map((row) => row.seq)).toEqual([0, 1, 2])
  expect(
    database
      .prepare(
        "SELECT session_id, message_end_seq, message_end_id FROM session_turns ORDER BY session_id"
      )
      .all()
      .map((row) => ({ ...row }))
  ).toEqual([
    { session_id: "edge", message_end_seq: 2, message_end_id: "er" },
    { session_id: "lab", message_end_seq: 9, message_end_id: "r-native" }
  ])
  expect(
    database
      .prepare(
        "SELECT session_id, active_message_count, visible_message_count FROM sessions ORDER BY session_id"
      )
      .all()
      .map((row) => ({ ...row }))
  ).toEqual([
    { session_id: "edge", active_message_count: 3, visible_message_count: 3 },
    { session_id: "lab", active_message_count: 8, visible_message_count: 8 }
  ])
  expect(
    database.prepare("SELECT through_sequence FROM chat_summaries WHERE session_id = 'lab'").get()
  ).toEqual({ through_sequence: 9 })
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
})

const chat = (database: DatabaseSync, session: string, count: number) => {
  database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
      active_message_count, visible_message_count, context_from_seq)
    VALUES ('${session}', '${session}-ref', '${AT}', '${AT}', ${count}, ${count}, 0)`)
  const row = database.prepare(`INSERT INTO session_messages
      (session_id, message_id, seq, role, message_json, client_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '${AT}')`)
  return (seq: number, message: Record<string, unknown>, clientId: string | null = null) =>
    row.run(
      session,
      String(message.message_id),
      seq,
      String(message.role),
      JSON.stringify({ ...message, turn_id: "t" }),
      clientId
    )
}

const toolTurn = (add: ReturnType<typeof chat>) => {
  add(0, { message_id: "u", role: "user", content: "Go" })
  add(1, { message_id: "a", role: "assistant", content: "", tool_calls: [call("d")] })
  add(2, { message_id: "r", role: "tool", tool_call_id: "d", content: "D out" })
}

const media = (add: ReturnType<typeof chat>, seq: number) =>
  add(
    seq,
    {
      message_id: `m${seq}`,
      role: "user",
      is_meta: true,
      content: [mediaHeader("d"), IMAGE]
    },
    "tool-media:d"
  )

it("migration 0176 leaves a person's message alone whatever its client id", () => {
  const database = migrated()
  const add = chat(database, "person", 4)
  toolTurn(add)
  for (const [seq, prefix] of ["tool-media:", "async-result:"].entries())
    add(3 + seq, { message_id: `p${seq}`, role: "user", content: "my words" }, `${prefix}d`)
  const before = database
    .prepare("SELECT seq, role, message_json FROM session_messages WHERE seq >= 3 ORDER BY seq")
    .all()
  toolResultsAsToolMessages.up(database)
  expect(
    database
      .prepare("SELECT seq, role, message_json FROM session_messages WHERE seq >= 3 ORDER BY seq")
      .all()
  ).toEqual(before)
})

it("migration 0176 moves every position that named a removed message to the message kept before it", () => {
  const database = migrated()
  const inner = chat(database, "inner", 5)
  toolTurn(inner)
  media(inner, 3)
  inner(4, { message_id: "after", role: "assistant", content: "Seen" })
  const trailing = chat(database, "trailing", 4)
  toolTurn(trailing)
  media(trailing, 3)
  database.exec(`UPDATE sessions SET context_from_seq = 4, active_message_count = 0,
    visible_message_count = 0 WHERE session_id = 'trailing'`)
  database.exec(`UPDATE memory_capture_unread SET read_seq = 1,
      prepared_json = json_object('end', json_object('sequence', 3)), prepared_cut_seq = 3
    WHERE session_id = 'inner'`)
  database.exec("UPDATE memory_capture_unread SET read_seq = 3 WHERE session_id = 'trailing'")
  database.exec(`INSERT INTO chat_summaries (session_id, title, summary, through_sequence, updated_at)
    VALUES ('inner', 'T', 'S', 4, '${AT}'), ('trailing', 'T', 'S', 3, '${AT}')`)
  database.exec(`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
      assistant_message_id, last_seq, ended_at)
    VALUES ('run-trailing', 'trailing', 'completed', '${AT}', '${AT}', 'a', 3, '${AT}')`)
  database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, metadata)
    VALUES ('fork', 'fork-ref', '${AT}', '${AT}', json_object('fork_origin', json_object(
      'sourceSessionId', 'inner', 'throughSequence', 3, 'sourceMessageId', 'm3')))`)
  toolResultsAsToolMessages.up(database)
  const row = (sql: string) => ({ ...database.prepare(sql).get() })
  expect(
    row(`SELECT read_seq, prepared_json, prepared_cut_seq FROM memory_capture_unread
      WHERE session_id = 'inner'`)
  ).toEqual({ read_seq: 1, prepared_json: null, prepared_cut_seq: null })
  expect(row("SELECT read_seq FROM memory_capture_unread WHERE session_id = 'trailing'")).toEqual({
    read_seq: 2
  })
  expect(
    database
      .prepare("SELECT session_id, through_sequence FROM chat_summaries ORDER BY session_id")
      .all()
      .map((summary) => ({ ...summary }))
  ).toEqual([
    { session_id: "inner", through_sequence: 4 },
    { session_id: "trailing", through_sequence: 2 }
  ])
  expect(row("SELECT last_seq FROM chat_runs WHERE run_id = 'run-trailing'")).toEqual({
    last_seq: 2
  })
  expect(
    row(`SELECT context_from_seq, active_message_count FROM sessions
      WHERE session_id = 'trailing'`)
  ).toEqual({ context_from_seq: 3, active_message_count: 0 })
  expect(
    row(`SELECT json_extract(metadata, '$.fork_origin.throughSequence') AS through_seq,
        json_extract(metadata, '$.fork_origin.sourceMessageId') AS message_id
      FROM sessions WHERE session_id = 'fork'`)
  ).toEqual({ through_seq: 2, message_id: "r" })
})
