import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { Persistence } from "../src/persistence/service.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const DAY = 86_400_000
const NOW = Date.now()
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

it("the hourly trim shrinks agent logs past the cutoff, archived too, and leaves a recent one and one inside the configured window", async () => {
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
        ["mid", 20],
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
        yield* sql`INSERT INTO tool_calls (run_id, session_id, tool_call_id, tool_name, arguments_json,
            changes_state, status, result_json, started_at, ended_at)
          VALUES (${`r-${id}`}, ${id}, ${`tc-${id}`}, 'web_search', '{}', 0, 'completed', '{}',
            ${at}, ${at})`
      }
      yield* sql`UPDATE sessions SET archived_at = ${start} WHERE session_id = 'shelved'`
      yield* persistence.retentionTick
      const messages = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM session_messages ORDER BY session_id`
      const calls = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM tool_calls WHERE session_id <> 'chat' ORDER BY session_id`
      return { messages, calls }
    })
  )
  expect(outcome.messages).toEqual([{ session_id: "mid" }, { session_id: "new" }])
  expect(outcome.calls).toEqual([{ session_id: "mid" }, { session_id: "new" }])
})
