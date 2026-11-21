import { errorMessage } from "@arden-hq/std/errors"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { spaceJobId, taskJobId } from "../src/persistence/space-job-id.js"
import { sessionPresentations } from "../src/persistence/sqlite/session-presentation.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// New in typed-execution: what each migrated reader says of a Task, and what
// settlement does when the Task's row is gone. Overlay only; the tracked
// modules keep a definition copy for a Task, so these do not run as a control.

const LATER = Date.now() + 60 * 60_000

const claim = (workerId: string, limit: number, now = LATER) =>
  Effect.gen(function* () {
    const queue = yield* AutomationQueue
    return yield* Effect.promise(async () =>
      queue.jobs.claim({ workerId, now, limit, leaseDurationMs: 60_000 })
    )
  })

const makeTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
    VALUES ('space-1', 'Made-up', 'made-up', '{"enabled":true}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
  const task = yield* (yield* WorkStore).create(
    { kind: "space", spaceId: "space-1" },
    { key: "background", text: "In the background" }
  )
  yield* sql`DELETE FROM automation_event_queue WHERE task_id = ${spaceJobId("space-1")}`
  return task
})

it("each reader of a Task's owner reads the Task's own row", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      const task = yield* makeTask
      const key = taskJobId(task.item_id)
      const waiting = yield* catalog.diagnostics()
      const [lease] = yield* claim("first", 10)
      if (lease === undefined) throw new Error("The Task was not claimed")
      const policy = yield* catalog.originPolicy(AutomationId.make(key))
      const running = yield* catalog.diagnostics()
      const shown = (row: (typeof running.queue)[number] | undefined) =>
        row === undefined
          ? undefined
          : {
              ofTask: row.task_id === key,
              name: row.name,
              enabled: row.enabled,
              internalRef: row.automation_ref.startsWith("internal-job~"),
              held: row.held_by_worker_since,
              chat: row.session_id
            }
      return {
        waiting: waiting.queue.map(shown),
        running: running.queue.map(shown),
        policy,
        chat: lease.payload.sessionId,
        missing: yield* catalog.originPolicy(AutomationId.make("task:no-such-task")).pipe(
          Effect.flip,
          Effect.map((error) => error.reason)
        )
      }
    })
  )
  expect(outcome.chat).toEqual(expect.any(String))
  expect(outcome).toEqual({
    waiting: [
      {
        ofTask: true,
        name: "In the background",
        enabled: 1,
        internalRef: true,
        held: null,
        // The Task's private chat is there before the first claim, and the claim keeps it.
        chat: outcome.chat
      }
    ],
    running: [
      {
        ofTask: true,
        name: "In the background",
        enabled: 1,
        internalRef: true,
        held: new Date(LATER).toISOString(),
        chat: outcome.chat
      }
    ],
    policy: { purpose: "task_execution", handler: null, threadId: outcome.chat },
    chat: outcome.chat,
    missing: "not_found"
  })
})

it("an attempt whose Task row is gone still ends, and its chat is still a Task worker's", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const queue = yield* AutomationQueue
      const task = yield* makeTask
      const key = taskJobId(task.item_id)
      const [lease] = yield* claim("first", 10)
      if (lease === undefined || lease.payload.sessionId === null)
        throw new Error("The Task was not claimed with a chat")
      // The row is removed under the running attempt, as no store method would.
      yield* sql`DELETE FROM space_tasks WHERE item_id = ${task.item_id}`
      const afterDelete = yield* sql<{ readonly status: string }>`
        SELECT status FROM automation_runs WHERE id = ${lease.payload.automationRunId}`
      const queuedAfterDelete = yield* sql`
        SELECT id FROM automation_event_queue WHERE task_id = ${key}`
      const settled = yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.complete({
            ...lease,
            completedAt: LATER + 1_000,
            result: {
              status: "ended",
              outcome: "finished",
              result: "Done",
              error: null,
              chatRunId: null,
              chatSessionId: null
            }
          })
        ).then(
          () => "settled",
          (error: unknown) => `refused: ${errorMessage(error)}`
        )
      )
      const attempt = yield* sql<{
        readonly status: string
        readonly ended: number
        readonly purpose: string
        readonly item_id: string
      }>`SELECT status, ended_at IS NOT NULL AS ended, purpose, item_id
        FROM automation_runs WHERE id = ${lease.payload.automationRunId}`
      const presentation = (yield* sessionPresentations(sql, [lease.payload.sessionId])).get(
        lease.payload.sessionId
      )
      return {
        afterDelete: afterDelete.map((row) => row.status),
        queuedAfterDelete: queuedAfterDelete.length,
        settled,
        attempt,
        queued: (yield* sql`SELECT id FROM automation_event_queue WHERE task_id = ${key}`).length,
        presentation,
        again: (yield* claim("second", 10, LATER + 10 * 60_000)).length
      }
    })
  )
  expect(outcome).toEqual({
    // Nothing closes the attempt or its queue row when the row is deleted by hand.
    afterDelete: ["running"],
    queuedAfterDelete: 1,
    // The fence is the queue row and the attempt, so the ending is still recorded.
    settled: "settled",
    attempt: [
      {
        status: "completed",
        ended: 1,
        purpose: "task_execution",
        item_id: "work:space-1:background"
      }
    ],
    queued: 0,
    presentation: { kind: "execution", label: "Task worker", title: "Task · Worker", owner: null },
    again: 0
  })
})
