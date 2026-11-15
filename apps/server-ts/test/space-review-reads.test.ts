import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { SpaceReviewStore } from "../src/persistence/automations/space-review-store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// A made-up review input in the shape retired by migration 0166: one page has the `resident` basis.
const page = { pageId: "p1", path: "p1.md", version: "v1", basis: "resident" }
const retiredInput = {
  admission: "changed",
  spaceId: "space-1",
  repositoryHead: null,
  pages: [{ ...page, rootPageId: "p1" }],
  chats: [],
  semantic: "{}",
  unresolved: [],
  reads: {
    space: { name: "Made up", instructions: null },
    openTasks: [],
    proposals: [],
    memory: { base: null, head: null },
    pages: [{ ...page, previousVersion: null }],
    chats: [],
    removed: [],
    items: []
  },
  prompt: "Made-up prompt"
}

it("reads only a running review's input, so a finished one is an archive no schema reads", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const reviews = yield* SpaceReviewStore
      const at = "2026-11-01T00:00:00.000Z"
      yield* sql`INSERT INTO automation_runs
        (task_id, purpose, started_at, ended_at, status, chat_run_id, input_json)
        VALUES ('job', 'space_review', ${at}, ${at}, 'completed', 'run-finished',
          ${JSON.stringify(retiredInput)})`
      return yield* reviews.reviewReads("run-finished").pipe(
        Effect.match({
          onFailure: (error) => error.message,
          onSuccess: (reads) => reads ?? "none"
        })
      )
    })
  )
  expect(outcome).toBe("none")
})
