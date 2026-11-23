import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { revokeAutomationWork } from "../src/persistence/sqlite/automation-authority.js"
import { hasOpenRunAsks } from "../src/persistence/sqlite/run-asks.js"
import { readRunLiveness } from "../src/persistence/sqlite/run-liveness.js"
import { runMayAct } from "../src/persistence/runs/liveness.js"
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
        VALUES ('session-person-turn', 'chat~person', ${AT}, ${AT}, 'chat'),
          ('session-woken-worker', 'chat~woken', ${AT}, ${AT}, 'chat'),
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
      const runIds = ["person-turn", "watch-run", "woken-worker"]
      const mayAct: Record<string, boolean> = {}
      const asksOpen: Record<string, boolean> = {}
      for (const runId of runIds) {
        const liveness = yield* readRunLiveness(sql, runId)
        mayAct[runId] = liveness !== undefined && runMayAct(liveness)
        asksOpen[runId] = yield* hasOpenRunAsks(sql, runId)
      }
      return { mayAct, asksOpen }
    })
  )
  expect(state).toEqual({
    mayAct: { "person-turn": true, "watch-run": false, "woken-worker": true },
    asksOpen: { "person-turn": false, "watch-run": false, "woken-worker": true }
  })
})
