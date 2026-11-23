import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { spaceJobId } from "../src/persistence/space-job-id.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { startJobs } from "./fixtures/job-runs.js"
import { freePage } from "./fixtures/free-space-page.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

it("only a Task change made by hand wakes the Space review; no run's change does", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const work = yield* WorkStore
      yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
        VALUES ('space-1', 'Made-up', 'made-up', '{"enabled":true}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
      yield* (yield* SpaceStore).bindPage("space-1", freePage("page-1", "projects/made-up.md"))
      const task = yield* work.create(
        { kind: "space", spaceId: "space-1" },
        { key: "background", text: "In the background" }
      )
      const jobs = yield* startJobs({
        [spaceJobId("space-1")]: "review",
        [`task:${task.item_id}`]: "worker"
      })
      yield* sql`DELETE FROM automation_event_queue`
      const queued = (text: string, runId?: string, actor?: "user" | "worker") =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly updated_at: string }>`
            SELECT updated_at FROM space_tasks WHERE item_id = ${task.item_id}`
          yield* work.update(
            { kind: "item", itemId: task.item_id },
            row?.updated_at ?? "",
            { text },
            runId,
            runId === undefined ? undefined : `${runId}-call`,
            actor
          )
          const [count] = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM automation_event_queue WHERE task_id = ${spaceJobId("space-1")}`
          return count?.n
        })
      return {
        review: yield* queued("By the review", jobs.get(spaceJobId("space-1"))),
        reviewActingAsOwner: yield* queued(
          "By the review as the owner",
          jobs.get(spaceJobId("space-1")),
          "user"
        ),
        workerWithoutRun: yield* queued("By a worker", undefined, "worker"),
        byHand: yield* queued("By the owner's hand")
      }
    })
  )
  expect(outcome).toEqual({ review: 0, reviewActingAsOwner: 0, workerWithoutRun: 0, byHand: 1 })
})
