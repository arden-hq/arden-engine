import { errorMessage } from "@arden-hq/std/errors"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { spaceJobId, taskJobId } from "../src/persistence/space-job-id.js"
import { sessionPresentations } from "../src/persistence/sqlite/session-presentation.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

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
    afterDelete: ["running"],
    queuedAfterDelete: 1,
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
    presentation: {
      kind: "execution",
      label: "Task worker",
      title: "Task · Worker",
      owner: { kind: "none" }
    },
    again: 0
  })
})
