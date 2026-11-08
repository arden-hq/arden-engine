import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { movedThreadLeftovers } from "../src/persistence/migrations/0034_moved_thread_leftovers.js"
import { migrations } from "../src/persistence/migrations/index.js"

const AT = "2026-09-28T00:00:00.000Z"

const migrated = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations.filter(
    (entry) => entry.version < movedThreadLeftovers.version
  ))
    migration.up(database)
  database.exec("PRAGMA foreign_keys = ON")
  return database
}

it("migration 0034 removes chat questions and Focus choices whose turn the transcript lost", () => {
  const database = migrated()

  database.exec(`INSERT INTO desks (desk_id, name, name_key, created_at, updated_at)
    VALUES ('desk', 'Lab', 'lab', '${AT}', '${AT}')`)
  database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, desk_id)
    VALUES ('lab', 'lab-ref', '${AT}', '${AT}', 'desk'), ('kev', 'kev-ref', '${AT}', '${AT}', 'desk'),
      ('cleared', 'cleared-ref', '${AT}', '${AT}', 'desk')`)
  database.exec(`INSERT INTO session_turns (session_id, turn_id, turn_index, user_message_id,
      message_start_id, message_end_id, message_start_seq, message_end_seq, started_at, ended_at)
    VALUES ('lab', 'kept', 0, 'kept', 'kept', 'kept', 0, 0, '${AT}', '${AT}')`)
  const run = database.prepare(`INSERT INTO chat_runs (run_id, session_id, status, stop_reason,
      started_at, updated_at, ended_at, metadata_json, assistant_message_id)
    VALUES (?, ?, 'completed', 'end_turn', '${AT}', '${AT}', '${AT}', ?, ?)`)
  const chat = (turn: string) => JSON.stringify({ turn_id: turn, run_context: { task: null } })
  run.run("run-gone", "lab", chat("reverted"), "a-1")
  run.run("run-kept", "lab", chat("kept"), "a-2")
  run.run(
    "run-task",
    "lab",
    JSON.stringify({ turn_id: "reverted", run_context: { task: { item_id: "t", generation: 0 } } }),
    "a-3"
  )
  run.run("run-cleared", "cleared", chat("old"), "a-4")
  const question = database.prepare(`INSERT INTO run_questions (question_id, run_id, tool_call_id,
      content, created_at) VALUES (?, ?, 'call', '{}', '${AT}')`)
  for (const [id, runId] of [
    ["q-gone", "run-gone"],
    ["q-kept", "run-kept"],
    ["q-task", "run-task"],
    ["q-cleared", "run-cleared"]
  ] as const)
    question.run(id, runId)
  const choice = database.prepare(`INSERT INTO focus_choices (choice_id, question_id,
      source_session_id, desk_id, revision, target_json, capture_policy_json, status, decision,
      result_session_id, settlement_client_id, created_at, updated_at, settled_at,
      target_session_id, transition, transitioned_at)
    VALUES (?, ?, 'lab', 'desk', 0, '{"kind":"create","name":"Kev"}', '{}', 'settled',
      'open_target', 'kev', 'client', '${AT}', '${AT}', '${AT}', 'kev', 'moved', '${AT}')`)
  choice.run("c-gone", "q-gone")
  choice.run("c-kept", "q-kept")

  movedThreadLeftovers.up(database)

  const ids = (query: string) =>
    database
      .prepare(query)
      .all()
      .map((row) => String(row.id))
  expect({
    questions: ids("SELECT question_id AS id FROM run_questions ORDER BY id"),
    choices: ids("SELECT choice_id AS id FROM focus_choices ORDER BY id"),
    sessions: ids("SELECT session_id AS id FROM sessions ORDER BY id"),
    broken: database.prepare("PRAGMA foreign_key_check").all().length
  }).toEqual({
    questions: ["q-cleared", "q-kept", "q-task"],
    choices: ["c-kept"],
    sessions: ["cleared", "kev", "lab"],
    broken: 0
  })
})

it("migration 0034 removes each moved-thread row as revert would: window, counts, hidden set, turn span", () => {
  const database = migrated()
  database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
      context_from_seq, active_message_count, visible_message_count)
    VALUES ('lab', 'lab-ref', '${AT}', '${AT}', 0, 3, 3),
      ('lab::f1', 'fork-ref', '${AT}', '${AT}', 0, 4, 1)`)
  const row = database.prepare(`INSERT INTO session_messages (session_id, message_id, seq, role,
      message_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
  const put = (session: string, id: string, seq: number, role: string, at: string, extra = {}) =>
    row.run(
      session,
      id,
      seq,
      role,
      JSON.stringify({ message_id: id, role, created_at: at, content: id, turn_id: "t", ...extra }),
      at
    )
  put("lab", "u", 0, "user", "2026-10-05T02:38:00.000Z")
  put("lab", "a", 1, "assistant", "2026-10-05T02:39:00.000Z")
  put("lab", "thread-moved:q1", 2, "assistant", "2026-09-27T23:17:02.884Z")
  put("lab", "thread-moved:q2", 3, "assistant", "2026-09-28T00:04:06.381Z")
  database.exec("INSERT INTO session_context_hidden (session_id, seq) VALUES ('lab', 3)")
  const fork = { forked_from: "lab" }
  put("lab::f1", "u", 0, "user", "2026-10-05T02:38:00.000Z", fork)
  put("lab::f1", "thread-moved:q1", 1, "assistant", "2026-09-27T23:17:02.884Z", fork)
  put("lab::f1", "a", 2, "assistant", "2026-10-05T02:39:00.000Z", fork)
  put("lab::f1", "summary", 3, "user", "2026-10-06T00:00:00.000Z", { turn_id: "s" })
  database.exec(`INSERT INTO session_turns (session_id, turn_id, turn_index, user_message_id,
      message_start_id, message_end_id, message_start_seq, message_end_seq, started_at, ended_at)
    VALUES ('lab', 't', 0, 't', 'u', 'thread-moved:q2', 0, 3, '2026-09-27T23:17:02.884Z',
        '2026-10-05T02:39:00.000Z'),
      ('lab::f1', 't', 0, 't', 'u', 'a', 0, 2, '2026-09-27T23:17:02.884Z', '2026-10-05T02:39:00.000Z'),
      ('lab::f1', 's', 1, 's', 'summary', 'summary', 3, 3, '2026-10-06T00:00:00.000Z',
        '2026-10-06T00:00:00.000Z')`)

  movedThreadLeftovers.up(database)

  const all = (query: string) =>
    database
      .prepare(query)
      .all()
      .map((entry) => ({ ...entry }))
  expect({
    messages: all(
      "SELECT session_id, message_id, seq FROM session_messages ORDER BY session_id, seq"
    ),
    counts: all(
      "SELECT session_id, active_message_count, visible_message_count FROM sessions ORDER BY session_id"
    ),
    hidden: all("SELECT * FROM session_context_hidden"),
    turns: all(`SELECT session_id, turn_id, turn_index, message_start_id, message_end_id,
        message_start_seq, message_end_seq, started_at, ended_at
      FROM session_turns ORDER BY session_id, turn_index`)
  }).toEqual({
    messages: [
      { session_id: "lab", message_id: "u", seq: 0 },
      { session_id: "lab", message_id: "a", seq: 1 },
      { session_id: "lab::f1", message_id: "u", seq: 0 },
      { session_id: "lab::f1", message_id: "a", seq: 2 },
      { session_id: "lab::f1", message_id: "summary", seq: 3 }
    ],
    counts: [
      { session_id: "lab", active_message_count: 2, visible_message_count: 2 },
      { session_id: "lab::f1", active_message_count: 3, visible_message_count: 1 }
    ],
    hidden: [],
    turns: [
      {
        session_id: "lab",
        turn_id: "t",
        turn_index: 0,
        message_start_id: "u",
        message_end_id: "a",
        message_start_seq: 0,
        message_end_seq: 1,
        started_at: "2026-10-05T02:38:00.000Z",
        ended_at: "2026-10-05T02:39:00.000Z"
      },
      {
        session_id: "lab::f1",
        turn_id: "t",
        turn_index: 0,
        message_start_id: "u",
        message_end_id: "a",
        message_start_seq: 0,
        message_end_seq: 2,
        started_at: "2026-10-05T02:38:00.000Z",
        ended_at: "2026-10-05T02:39:00.000Z"
      },
      {
        session_id: "lab::f1",
        turn_id: "s",
        turn_index: 1,
        message_start_id: "summary",
        message_end_id: "summary",
        message_start_seq: 3,
        message_end_seq: 3,
        started_at: "2026-10-06T00:00:00.000Z",
        ended_at: "2026-10-06T00:00:00.000Z"
      }
    ]
  })
})
