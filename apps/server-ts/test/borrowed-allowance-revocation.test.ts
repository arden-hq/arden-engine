import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { revokeAutomationWork } from "../src/persistence/sqlite/automation-authority.js"
import { runCancellationRequested } from "../src/persistence/sqlite/run-cancellation.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { inUnitOfWork } from "./fixtures/unit-of-work.js"

const AT = "2026-10-12T09:00:00.000Z"
const WATCH = "automation:watch"

const seedRun = (
  sql: SqlClient.SqlClient,
  run: { readonly id: string; readonly worksFor: string | null; readonly causedBy: string | null }
) =>
  sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
      metadata_json, assistant_message_id, authority_json)
    VALUES (${run.id}, ${`session-${run.id}`}, 'running', ${AT}, ${AT},
      json_object('run_policy', json_object('budget_id', 'shared', 'automation_id', ${run.worksFor})),
      ${`assistant-${run.id}`},
      json_object('owns', json_object('automation_id', ${run.causedBy})))`

it("an Automation that stops ends the runs that work for it and their asks, never a run it only woke", async () => {
  const state = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO execution_budgets (budget_id) VALUES ('shared')`
      yield* seedRun(sql, { id: "person-turn", worksFor: null, causedBy: null })
      yield* seedRun(sql, { id: "woken-worker", worksFor: null, causedBy: WATCH })
      yield* seedRun(sql, { id: "watch-run", worksFor: WATCH, causedBy: WATCH })
      yield* sql`INSERT INTO run_questions (question_id, run_id, tool_call_id, content, created_at)
        VALUES ('woken-question', 'woken-worker', 'ask', '{}', ${AT}),
          ('watch-question', 'watch-run', 'ask', '{}', ${AT})`
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type)
        VALUES ('session-woken-worker', 'chat~woken', ${AT}, ${AT}, 'chat'),
          ('session-watch-run', 'chat~watch', ${AT}, ${AT}, 'chat')`
      yield* sql`INSERT INTO tool_calls (run_id, session_id, tool_call_id, tool_name,
          arguments_json, changes_state, status, result_json, started_at, ended_at)
        VALUES ('woken-worker', 'session-woken-worker', 'card', 'exec_command', '{}', 1, 'paused', NULL, ${AT}, ${AT}),
          ('watch-run', 'session-watch-run', 'card', 'exec_command', '{}', 1, 'paused', NULL, ${AT}, ${AT})`
      yield* sql`INSERT INTO deferred_tool_calls (run_id, session_id, tool_call_id, tool_name,
          action, scope, arguments_json, changes_state, status, requested_at)
        VALUES ('woken-worker', 'session-woken-worker', 'card', 'exec_command', 'run', 'shell', '{}', 1, 'pending', ${AT}),
          ('watch-run', 'session-watch-run', 'card', 'exec_command', 'run', 'shell', '{}', 1, 'pending', ${AT})`
      yield* inUnitOfWork(
        revokeAutomationWork({
          sql,
          sessionEvents: yield* SessionLifecycleEvents,
          automationId: WATCH
        })
      )
      return {
        runs: yield* sql`SELECT run_id, ${runCancellationRequested(sql, sql`metadata_json`)} AS stopped
          FROM chat_runs ORDER BY run_id`,
        questions: yield* sql`SELECT question_id, closed_at IS NOT NULL AS closed
          FROM run_questions ORDER BY question_id`,
        cards: yield* sql`SELECT run_id, status FROM deferred_tool_calls ORDER BY run_id`
      }
    })
  )
  expect(state).toEqual({
    runs: [
      { run_id: "person-turn", stopped: 0 },
      { run_id: "watch-run", stopped: 1 },
      { run_id: "woken-worker", stopped: 0 }
    ],
    questions: [
      { question_id: "watch-question", closed: 1 },
      { question_id: "woken-question", closed: 0 }
    ],
    cards: [
      { run_id: "watch-run", status: "rejected" },
      { run_id: "woken-worker", status: "pending" }
    ]
  })
})
