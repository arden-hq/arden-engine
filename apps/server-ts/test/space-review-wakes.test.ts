import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { wikiChangedEvent } from "../src/automations/producers/wiki.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const REVISION = "a".repeat(64)

// A Memory page change alone never starts a Space review (the admission table's `memory_page`
// row), so a Memory save must not queue one either: no queue row, no skip row, no work.
it("a Memory save queues no Space review, and a stored subscription to it is dropped", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      const triggers = yield* AutomationTriggers
      const now = new Date().toISOString()
      yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
        VALUES ('space-1', 'Made-up Space', 'made-up space', '{"enabled":true}', ${now}, ${now})`
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      // A review job stored before this change still subscribes to Memory saves.
      yield* sql`UPDATE scheduled_tasks
        SET triggers = '[{"type":"event","event_type":"wiki.changed","id":"t1"}]', trigger_last_id = 1
        WHERE purpose = 'space_review'`
      yield* spaces.update("space-1", { name: "Made-up Space again" })
      const jobs = yield* sql<{ readonly triggers: string }>`
        SELECT triggers FROM scheduled_tasks WHERE purpose = 'space_review'`
      const queuedBefore = yield* sql<{
        readonly id: number
      }>`SELECT id FROM automation_event_queue`
      const dispatched = yield* triggers.dispatchEvent(
        wikiChangedEvent({
          paths: ["projects/made-up-space.md"],
          revision: REVISION,
          savedAt: now,
          source: "user",
          hasSpacePage: true,
          producedBy: null,
          chainDepth: 0
        })
      )
      const queuedAfter = yield* sql<{ readonly id: number }>`SELECT id FROM automation_event_queue`
      return {
        jobs: jobs.map((job) => job.triggers),
        dispatched,
        added: queuedAfter.length - queuedBefore.length
      }
    })
  )
  expect(outcome.jobs).toEqual(["[]"])
  expect(outcome.dispatched).toEqual({ queued: 0 })
  expect(outcome.added).toBe(0)
})
