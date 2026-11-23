import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { readTaskDirection } from "../src/persistence/sqlite/task-direction.js"
import { DeferredToolCalls } from "../src/persistence/tools/deferred.js"
import { ToolExecutionStore, type ToolExecutionIdentity } from "../src/persistence/tools/store.js"
import {
  ensureMutationReceipt,
  readMutationReceipt
} from "../src/persistence/tools/mutation-receipt.js"
import { WorkStore } from "../src/persistence/work/store.js"
import {
  taskDirectionReceipt,
  taskDirectionReview
} from "../src/persistence/work/task-direction.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-11-20T08:00:00.000Z"

const seed = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type)
      VALUES ('session-1', 'chat~1', ${AT}, ${AT}, 'chat')`
    yield* sql`INSERT INTO execution_budgets (budget_id) VALUES ('budget-1')`
    yield* sql`INSERT INTO space_tasks (item_id, stable_key, text, body, status, owner, created_at, updated_at)
      VALUES ('task-1', 'task-1', 'Goal A', 'Write A', 'open', 'worker', ${AT}, ${AT})`
    for (const [runId, task] of [
      ["run-task", { task: { item_id: "task-1", generation: 0 } }],
      ["run-plain", {}]
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
          'run_context', json(${JSON.stringify(task)})),
          ${`assistant-${runId}`})`
  })

const call = (runId: string, toolCallId: string) =>
  ({
    runId,
    sessionId: "session-1",
    toolCallId,
    toolName: "task_get",
    arguments: {},
    changesState: false,
    effect: "none"
  }) satisfies ToolExecutionIdentity

const shownNow = (sql: SqlClient.SqlClient) =>
  readTaskDirection(sql, "task-1").pipe(
    Effect.flatMap((direction) =>
      direction === undefined
        ? Effect.die("the Task is gone")
        : Effect.succeed(taskDirectionReceipt(direction))
    )
  )

it("a call runs only on the direction it was planned from; notes never ask for review", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tools = yield* ToolExecutionStore
      yield* seed(sql)
      const planA = yield* shownNow(sql)
      yield* tools.begin(call("run-task", "planned"), { plan: { kind: "turn", shown: planA } })
      yield* tools.begin(call("run-task", "unplanned"))
      yield* tools.begin(call("run-plain", "plain"))
      const before = yield* tools.admitPlanned(call("run-task", "planned"))
      yield* sql`UPDATE space_tasks SET continuation_context = '{"done":[],"in_progress":[],"decided":[],"rejected":[],"next":["a note"],"added":{"done":[],"decided":[]},"written_at":"2026-11-20T08:00:00.000Z","run_id":null}',
        updated_at = '2026-11-20T08:01:00.000Z' WHERE item_id = 'task-1'`
      const afterNotes = yield* tools.admitPlanned(call("run-task", "planned"))
      yield* sql`INSERT INTO task_contract_lines (item_id, kind, text, source_message_id, created_at)
        VALUES ('task-1', 'rule', 'Never write A', 'message-1', ${AT})`
      const afterContract = yield* tools.admitPlanned(call("run-task", "planned"))
      const planWithRule = yield* shownNow(sql)
      yield* tools.begin(call("run-task", "replanned"), {
        plan: { kind: "turn", shown: planWithRule }
      })
      const replanned = yield* tools.admitPlanned(call("run-task", "replanned"))
      yield* sql`UPDATE space_tasks SET text = 'Goal B' WHERE item_id = 'task-1'`
      return {
        before,
        afterNotes,
        afterContract,
        replanned,
        afterText: yield* tools.admitPlanned(call("run-task", "replanned")),
        legacy: yield* tools.admitPlanned(call("run-task", "unplanned")),
        plain: yield* tools.admitPlanned(call("run-plain", "plain"))
      }
    })
  )
  expect(outcome).toEqual({
    before: "current",
    afterNotes: "current",
    afterContract: "needs_review",
    replanned: "current",
    afterText: "needs_review",
    legacy: "needs_review",
    plain: "current"
  })
})

it("a Task write checks its call's plan inside the write's own transaction", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tools = yield* ToolExecutionStore
      const work = yield* WorkStore
      yield* seed(sql)
      const task = { kind: "item", itemId: "task-1" } as const
      yield* tools.begin(call("run-task", "note-a"), {
        plan: { kind: "turn", shown: yield* shownNow(sql) }
      })
      const admitted = yield* tools.admitPlanned(call("run-task", "note-a"))
      const before = yield* work.get(task)
      yield* work.update(task, before.updated_at, { text: "Goal B" }, undefined, undefined, "user")
      const stale = yield* work
        .comment(task, { body: "A note" }, "run-task", "note-a")
        .pipe(Effect.flip)
      const current = yield* work.get(task)
      yield* tools.begin(call("run-task", "update-a"), {
        plan: { kind: "turn", shown: undefined }
      })
      const staleBoth = yield* work
        .update(task, before.updated_at, { body: "A details" }, "run-task", "update-a")
        .pipe(Effect.flip)
      yield* tools.begin(call("run-task", "note-b"), {
        plan: { kind: "turn", shown: yield* shownNow(sql) }
      })
      const fresh = yield* work.comment(task, { body: "B note" }, "run-task", "note-b")
      const unnamed = yield* work.comment(task, { body: "run note" }, "run-task")
      const comments = yield* sql<{ readonly body: string }>`
        SELECT body FROM space_task_comments WHERE item_id = 'task-1' ORDER BY rowid`
      return {
        admitted,
        stale: stale._tag,
        staleBoth: staleBoth._tag,
        fresh: fresh.body,
        unnamed: unnamed.body,
        text: current.text,
        comments: comments.map((row) => row.body)
      }
    })
  )
  expect(outcome).toEqual({
    admitted: "current",
    stale: "TaskDirectionChanged",
    staleBoth: "TaskDirectionChanged",
    fresh: "B note",
    unnamed: "run note",
    text: "Goal B",
    comments: ["B note", "run note"]
  })
})

it("a card is published only for a plan its Task still has, checked where it is published", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tools = yield* ToolExecutionStore
      const cards = yield* DeferredToolCalls
      yield* seed(sql)
      const card = (toolCallId: string) => ({
        call: {
          runId: "run-task",
          sessionId: "session-1",
          toolCallId,
          toolName: "file_write",
          arguments: { path: "/tmp/a.txt", content: "A" },
          changesState: true,
          data: undefined
        },
        prompt: { preview: "Write a.txt" }
      })
      yield* tools.begin(call("run-task", "write-a"), {
        plan: { kind: "turn", shown: yield* shownNow(sql) }
      })
      const checked = yield* tools.admitPlanned(call("run-task", "write-a"))
      yield* sql`UPDATE space_tasks SET text = 'Goal B' WHERE item_id = 'task-1'`
      const stale = yield* cards.defer(card("write-a"))
      yield* tools.begin(call("run-task", "write-b"), {
        plan: { kind: "turn", shown: yield* shownNow(sql) }
      })
      const fresh = yield* cards.defer(card("write-b"))
      const rows = yield* sql<{ readonly tool_call_id: string }>`
        SELECT tool_call_id FROM deferred_tool_calls ORDER BY rowid`
      const announced = yield* sql<{ readonly id: string }>`
        SELECT json_extract(data_json, '$.tool_call_id') AS id FROM journal_records
        WHERE instr(data_json, 'approval_waiting') > 0 ORDER BY rowid`
      return {
        checked,
        stale,
        fresh,
        cards: rows.map((row) => row.tool_call_id),
        announced: announced.map((row) => row.id)
      }
    })
  )
  expect(outcome).toEqual({
    checked: "current",
    stale: "needs_review",
    fresh: "published",
    cards: ["write-b"],
    announced: ["write-b"]
  })
})

it("a call refused for review leaves a known no-op receipt, never an unknown one", () => {
  const identity = { runId: "run-task", toolCallId: "call-a" }
  const review = taskDirectionReview()
  const reviewed = ensureMutationReceipt(identity, {
    content: review.message,
    preview: "Not run",
    is_error: true,
    ...(review.host === undefined ? {} : { host: review.host })
  })
  const failed = ensureMutationReceipt(identity, {
    content: "Task update failed",
    preview: "Failed",
    is_error: true
  })
  expect({
    reviewed: readMutationReceipt(reviewed.host)?.outcome,
    failed: readMutationReceipt(failed.host)?.outcome
  }).toEqual({ reviewed: "no_op", failed: "unknown" })
})
