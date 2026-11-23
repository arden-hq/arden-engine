import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { fenceRunCancellation } from "../src/persistence/sqlite/run-cancellation.js"
import { ToolExecutionStore, type ToolExecutionIdentity } from "../src/persistence/tools/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { inUnitOfWork } from "./fixtures/unit-of-work.js"

const AT = "2026-11-20T07:00:00.000Z"

const seed = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type)
      VALUES ('session-1', 'chat~1', ${AT}, ${AT}, 'chat')`
    yield* sql`INSERT INTO execution_budgets (budget_id) VALUES ('budget-1')`
    yield* sql`INSERT INTO space_tasks (item_id, stable_key, text, status, owner, created_at, updated_at)
      VALUES ('task-open', 'open', 'Open Task', 'open', 'worker', ${AT}, ${AT})`
    yield* sql`INSERT INTO space_tasks (item_id, stable_key, text, status, owner, created_at, updated_at)
      VALUES ('task-done', 'done', 'Done Task', 'done', 'worker', ${AT}, ${AT})`
    yield* sql`INSERT INTO space_task_events (item_id, run_ref, event_type, summary, created_at)
      VALUES ('task-done', 'run-settling', 'done', 'Done.', ${AT})`
    for (const [runId, itemId] of [
      ["run-active", "task-open"],
      ["run-stopped", "task-open"],
      ["run-settling", "task-done"]
    ] as const)
      yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
          metadata_json, assistant_message_id)
        VALUES (${runId}, 'session-1', 'running', ${AT}, ${AT},
          json_object('run_policy', json_object(
            'budget_id', 'budget-1',
            'execution', json_object('mode', 'inline', 'observe', json('false')),
            'capabilities', json_array('all'),
            'auto_approve', json('false'),
            'google_accounts', NULL,
            'space', NULL),
          'run_context', json_object('task', json_object('item_id', ${itemId}, 'generation', 0))),
          ${`assistant-${runId}`})`
  })

const call = (runId: string, toolCallId: string, args: Record<string, unknown> = {}) =>
  ({
    runId,
    sessionId: "session-1",
    toolCallId,
    toolName: "task_comment",
    arguments: args,
    changesState: true,
    effect: "arden_db"
  }) satisfies ToolExecutionIdentity

it("a run whose Task authority ended is not admitted, records nothing, and is no store error", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tools = yield* ToolExecutionStore
      yield* seed(sql)
      yield* inUnitOfWork(
        fenceRunCancellation({
          sql,
          sessionEvents: yield* SessionLifecycleEvents,
          runId: "run-stopped",
          now: AT
        })
      )
      const begun = {
        active: yield* tools.begin(call("run-active", "a")),
        stopped: yield* tools.begin(call("run-stopped", "s")),
        settling: yield* tools.begin(call("run-settling", "f"))
      }
      const rows = yield* sql<{ readonly run_id: string; readonly tool_call_id: string }>`
        SELECT run_id, tool_call_id FROM tool_calls ORDER BY rowid`
      return { begun, rows }
    })
  )
  expect(outcome).toEqual({
    begun: {
      active: { _tag: "Started" },
      stopped: { _tag: "NotAdmitted", authority: "revoked" },
      settling: { _tag: "NotAdmitted", authority: "settling" }
    },
    rows: [{ run_id: "run-active", tool_call_id: "a" }]
  })
})

const seedPlainRun = (sql: SqlClient.SqlClient, runId: string, budgetId: string) =>
  sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
      metadata_json, assistant_message_id)
    VALUES (${runId}, 'session-1', 'running', ${AT}, ${AT},
      json_object('run_policy', json_object(
        'budget_id', ${budgetId},
        'execution', json_object('mode', 'inline', 'observe', json('false')),
        'capabilities', json_array('all'),
        'auto_approve', json('false'),
        'google_accounts', NULL,
        'space', NULL)),
      ${`assistant-${runId}`})`

it("a spent budget is not admitted; a budget that does not exist is an integrity error", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tools = yield* ToolExecutionStore
      yield* seed(sql)
      yield* sql`INSERT INTO execution_budgets (budget_id, token_limit, tokens_used)
        VALUES ('budget-spent', 10, 10)`
      yield* seedPlainRun(sql, "run-spent", "budget-spent")
      yield* seedPlainRun(sql, "run-dangling", "budget-gone")
      const spent = yield* tools.begin(call("run-spent", "p"))
      const dangling = yield* Effect.flip(tools.begin(call("run-dangling", "d")))
      const rows = yield* sql<{ readonly run_id: string }>`SELECT run_id FROM tool_calls`
      return {
        spent,
        dangling: { tag: dangling._tag, reason: dangling.reason },
        rows
      }
    })
  )
  expect(outcome).toEqual({
    spent: { _tag: "NotAdmitted", authority: "revoked" },
    dangling: {
      tag: "ToolExecutionStoreError",
      reason: "corrupt"
    },
    rows: []
  })
})

it("an identity conflict and a missing run stay store errors", async () => {
  const errors = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tools = yield* ToolExecutionStore
      yield* seed(sql)
      yield* tools.begin(call("run-active", "same", { body: "first" }))
      const conflict = yield* Effect.flip(
        tools.begin(call("run-active", "same", { body: "other" }))
      )
      const missing = yield* Effect.flip(tools.begin(call("run-none", "x")))
      return {
        conflict: { tag: conflict._tag, reason: conflict.reason },
        missing: { tag: missing._tag, reason: missing.reason }
      }
    })
  )
  expect(errors).toEqual({
    conflict: { tag: "ToolExecutionStoreError", reason: "conflict" },
    missing: { tag: "ToolExecutionStoreError", reason: "not_found" }
  })
})
