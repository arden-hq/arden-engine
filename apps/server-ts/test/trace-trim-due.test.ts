import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { Persistence } from "../src/persistence/service.js"
import { databaseSchema } from "../src/persistence/schema/database.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const KIND = `CASE
  WHEN s.session_type = 'agent' THEN 'agent'
  WHEN s.session_type = 'chat' AND s.parent_session_id IS NOT NULL
    AND s.origin_automation_id IS NOT NULL
    AND COALESCE(json_type(s.metadata, '$.fork_origin'), json_type(s.metadata, '$.fork_of')) IS NOT NULL
    THEN 'fork'
END`

// What the hourly trim used to work out by reading every chat.
const recount = (database: DatabaseSync) =>
  database
    .prepare(
      `SELECT s.session_id, ${KIND} AS kind, run.run_id, run.ended_at
       FROM sessions AS s
       JOIN chat_runs AS run ON run.run_id = (
         SELECT candidate.run_id FROM chat_runs AS candidate
         WHERE candidate.session_id = s.session_id
         ORDER BY candidate.updated_at DESC, candidate.started_at DESC, candidate.run_id DESC
         LIMIT 1)
       WHERE run.ended_at IS NOT NULL AND ${KIND} IS NOT NULL
         AND COALESCE(json_extract(s.metadata, '$.agent_trace_retained_run_id'), '') <> run.run_id
       ORDER BY s.session_id`
    )
    .all()

const saved = (database: DatabaseSync) =>
  database
    .prepare(`SELECT session_id, kind, run_id, ended_at FROM trace_trim_due ORDER BY session_id`)
    .all()

// The hourly trim reads the chats that wait for it from a list that triggers
// keep. After every kind of change the list must equal a fresh look at the rows.
it("the due-for-trim list equals a fresh look after runs start, end and chats go", () => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of databaseSchema.statements) database.exec(statement)
    const run = (id: string, session: string, at: string) =>
      `INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, metadata_json,
           assistant_message_id)
         VALUES ('${id}', '${session}', 'running', '${at}', '${at}', '{"turn_id":"t-${id}"}', 'am-${id}')`
    const end = (id: string, at: string) =>
      `UPDATE chat_runs SET status = 'cancelled', ended_at = '${at}', updated_at = '${at}'
         WHERE run_id = '${id}'`
    const steps: ReadonlyArray<string> = [
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type, name)
         VALUES ('chat', 'ref-chat', '2026-09-01', '2026-09-01', 'chat', 'A chat')`,
      run("c1", "chat", "2026-09-01"),
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type,
           parent_session_id, parent_run_id, parent_tool_call_id)
         VALUES ('agent', 'ref-agent', '2026-09-01', '2026-09-01', 'agent', 'chat', 'c1', 'tc1'),
                ('agent2', 'ref-agent2', '2026-09-01', '2026-09-01', 'agent', 'chat', 'c1', 'tc2')`,
      run("a1", "agent", "2026-09-01"),
      run("b1", "agent2", "2026-09-01"),
      end("c1", "2026-09-02"),
      end("a1", "2026-09-02"),
      end("b1", "2026-09-02"),
      run("a2", "agent", "2026-09-03"),
      end("a2", "2026-09-04"),
      `UPDATE chat_runs SET metadata_json = '{"turn_id":"t-a2","more":1}' WHERE run_id = 'a2'`,
      `DELETE FROM sessions WHERE session_id = 'agent2'`
    ]
    const sizes: Array<number> = []
    for (const step of steps) {
      database.exec(step)
      expect(saved(database), step).toEqual(recount(database))
      sizes.push(saved(database).length)
    }
    // An ordinary chat never enters the list; both agents did; one left with its chat.
    expect(Math.max(...sizes)).toBe(2)
    expect(saved(database)).toEqual([
      { session_id: "agent", kind: "agent", run_id: "a2", ended_at: "2026-09-04" }
    ])
  } finally {
    database.close()
  }
})

const DAY = 86_400_000
// One clock reading for the file: two times asked for the same moment must be equal.
const NOW = Date.now()
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

it("the hourly trim shrinks agent logs past the cutoff, archived too, and leaves a recent one", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const persistence = yield* Persistence
      yield* sql`INSERT INTO storage_retention (singleton_id, agent_trace_days, wiki_history_days)
        VALUES (1, 30, NULL)
        ON CONFLICT(singleton_id) DO UPDATE SET agent_trace_days = 30`
      const start = ago(50)
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type, name)
        VALUES ('chat', 'ref-chat', ${start}, ${start}, 'chat', 'A chat')`
      yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
          ended_at, metadata_json, assistant_message_id)
        VALUES ('r-chat', 'chat', 'cancelled', ${start}, ${start}, ${start},
          '{"turn_id":"t-chat"}', 'am-chat')`
      for (const [id, days] of [
        ["old", 40],
        ["shelved", 40],
        ["new", 5]
      ] as const) {
        const at = ago(days)
        yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
            session_type, parent_session_id, parent_run_id, parent_tool_call_id)
          VALUES (${id}, ${`ref-${id}`}, ${at}, ${at}, 'agent', 'chat', 'r-chat',
            ${`tc-${id}`})`
        yield* sql`INSERT INTO session_messages (session_id, message_id, seq, role, message_json, created_at)
          VALUES (${id}, ${`m-${id}`}, 1, 'user', '{"role":"user","content":"do it"}', ${at})`
        yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
            metadata_json, assistant_message_id)
          VALUES (${`r-${id}`}, ${id}, 'running', ${at}, ${at},
            ${JSON.stringify({ turn_id: `t-${id}` })}, ${`am-${id}`})`
        yield* sql`UPDATE chat_runs SET status = 'cancelled', ended_at = ${at}
          WHERE run_id = ${`r-${id}`}`
      }
      // An archived chat has no row in the chat list; the trim must still shrink it.
      yield* sql`UPDATE sessions SET archived_at = ${start} WHERE session_id = 'shelved'`
      yield* persistence.retentionTick
      const messages = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM session_messages ORDER BY session_id`
      const due = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM trace_trim_due ORDER BY session_id`
      const marked = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM sessions
        WHERE json_extract(metadata, '$.agent_trace_retained_run_id') IS NOT NULL
        ORDER BY session_id`
      return { messages, due, marked }
    })
  )
  expect(outcome.messages).toEqual([{ session_id: "new" }])
  expect(outcome.due).toEqual([{ session_id: "new" }])
  expect(outcome.marked).toEqual([{ session_id: "old" }, { session_id: "shelved" }])
})
