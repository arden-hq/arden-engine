import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { taskJobId } from "../src/persistence/space-job-id.js"
import { ensureTaskBudget } from "../src/persistence/sqlite/in-chat-task.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { startJob } from "./fixtures/job-runs.js"
import { claim, makeAutomation, makeTask, requestRun, storeUnderKey } from "./work-fixtures.js"

// Bounded repair, finding 4: a run spends a Task's budget only when its owner
// is that Task. The owner's key looking like a Task's key says nothing. Overlay only.

/** The budget the run was admitted with, and the budget the Task keeps. */
const budgets = (runId: string, itemId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const run = yield* sql<{ readonly budget_id: string | null }>`
      SELECT json_extract(metadata_json, '$.run_policy.budget_id') AS budget_id
      FROM chat_runs WHERE run_id = ${runId}`
    const task = yield* sql<{ readonly budget_id: string }>`
      SELECT budget_id FROM execution_budgets WHERE task_item_id = ${itemId}`
    return { run: run[0]?.budget_id, task: task[0]?.budget_id }
  })

it("a Task's own run spends the Task's budget", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const task = yield* makeTask
      yield* ensureTaskBudget(sql, task.item_id, 7)
      const [lease] = yield* claim("first", 10)
      if (lease === undefined) throw new Error("The Task was not claimed")
      const { run } = yield* startJob(lease, "task-run")
      return {
        purpose: lease.payload.purpose,
        ...(yield* budgets(run.runId, task.item_id))
      }
    })
  )
  expect(outcome.purpose).toBe("task_execution")
  expect(outcome.task).toBeDefined()
  expect(outcome.run).toBe(outcome.task)
})

it("an Automation stored under a Task's key does not spend the Task's budget", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const task = yield* makeTask
      const key = taskJobId(task.item_id)
      yield* ensureTaskBudget(sql, task.item_id, 7)
      // The Task's own wake goes: the run below is the Automation's, asked for by hand.
      yield* sql`DELETE FROM automation_event_queue WHERE task_id = ${key}`
      yield* storeUnderKey(yield* makeAutomation, key)
      yield* requestRun(key)
      const [lease] = yield* claim("first", 10)
      if (lease === undefined) throw new Error("The Automation was not claimed")
      const { run } = yield* startJob(lease, "automation-run")
      return {
        key: lease.payload.automationId === key,
        purpose: lease.payload.purpose,
        ...(yield* budgets(run.runId, task.item_id))
      }
    })
  )
  expect(outcome.key).toBe(true)
  expect(outcome.purpose).toBe("user_automation")
  expect(outcome.task).toBeDefined()
  expect(outcome.run).toBeDefined()
  expect(outcome.run).not.toBe(outcome.task)
})
