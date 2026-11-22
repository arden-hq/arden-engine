import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-11-21T07:00:00.000Z"

const taskRun = (sql: SqlClient.SqlClient, itemId: string) =>
  Effect.gen(function* () {
    const runId = `run-${itemId}`
    const sessionId = `session-${itemId}`
    yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type)
      VALUES (${sessionId}, ${`chat~${itemId}`}, ${AT}, ${AT}, 'chat')`
    yield* sql`INSERT INTO execution_budgets (budget_id) VALUES (${`budget-${itemId}`})`
    yield* sql`INSERT INTO space_tasks (item_id, stable_key, text, status, owner, created_at, updated_at)
      VALUES (${itemId}, ${itemId}, ${itemId}, 'open', 'worker', ${AT}, ${AT})`
    yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
        metadata_json, assistant_message_id)
      VALUES (${runId}, ${sessionId}, 'running', ${AT}, ${AT},
        json_object('turn_id', ${`turn-${runId}`}, 'run_policy', json_object(
          'budget_id', ${`budget-${itemId}`},
          'execution', json_object('mode', 'inline', 'observe', json('false')),
          'capabilities', json_array('all'),
          'auto_approve', json('false'),
          'google_accounts', NULL,
          'space', NULL),
        'run_context', json_object('task', json_object('item_id', ${itemId}, 'generation', 0))),
        ${`assistant-${runId}`})`
    return { runId, sessionId }
  })

const status = (sql: SqlClient.SqlClient, runId: string, toolCallId: string) =>
  sql<{ readonly status: string }>`SELECT status FROM tool_approvals
    WHERE run_id = ${runId} AND tool_call_id = ${toolCallId}`.pipe(
    Effect.map((rows) => rows[0]?.status)
  )

it("a card whose Task was closed cannot be allowed; it can still be denied", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tools = yield* ToolExecutionStore
      const kept = yield* taskRun(sql, "task-kept")
      const closed = yield* taskRun(sql, "task-cancelled")
      for (const [{ runId, sessionId }, toolCallId] of [
        [kept, "write"],
        [closed, "write"],
        [closed, "other"]
      ] as const) {
        const call = {
          runId,
          sessionId,
          toolCallId,
          toolName: "file_write",
          arguments: { path: `/tmp/${toolCallId}` },
          changesState: false
        }
        yield* tools.begin(call)
        yield* tools.pause(call, { reason: "approval", preview: toolCallId })
      }
      yield* sql`UPDATE space_tasks SET status = 'cancelled', updated_at = ${AT}
        WHERE item_id = 'task-cancelled'`
      const allowed = yield* Effect.flip(
        tools.resolve({
          runId: closed.runId,
          toolCallId: "write",
          approved: true,
          grantStanding: true
        })
      )
      return {
        allowed: { reason: allowed.reason, message: allowed.message },
        afterAllow: yield* status(sql, closed.runId, "write"),
        denied: yield* tools
          .resolve({ runId: closed.runId, toolCallId: "other", approved: false })
          .pipe(Effect.as("settled")),
        afterDeny: yield* status(sql, closed.runId, "other"),
        kept: yield* tools
          .resolve({ runId: kept.runId, toolCallId: "write", approved: true })
          .pipe(Effect.as("settled")),
        afterKept: yield* status(sql, kept.runId, "write")
      }
    })
  )
  expect(outcome).toEqual({
    allowed: {
      reason: "conflict",
      message: "This card's Task no longer lets its run act; it can only be denied"
    },
    afterAllow: "pending",
    denied: "settled",
    afterDeny: "rejected",
    kept: "settled",
    afterKept: "approved"
  })
})
