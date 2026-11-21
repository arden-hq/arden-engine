import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { readWorkOwner } from "../src/persistence/sqlite/automation-rows.js"
import { spaceJobId } from "../src/persistence/space-job-id.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { freePage } from "./fixtures/free-space-page.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { makeTask } from "./work-fixtures.js"

// Migrated expectation (space-review-owner): the baseline wrote model, cooldown and an
// unused prompt into the review's definition row and read them back. A review has no
// definition row now. Its settings are `space_review_settings`, which only migration
// 180 fills from an old row, so the test writes that row as 180 would. The checks on
// the owner are the baseline's: the settings a run consumes, and nothing authored.
it("a Space review owner carries only the review settings a run consumes", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* makeTask
      yield* spaces.bindPage("space-1", freePage("page-1", "projects/made-up.md"))
      const defaults = yield* readWorkOwner(sql, spaceJobId("space-1"))
      yield* sql`INSERT INTO space_review_settings (space_id, model, cooldown_minutes)
        VALUES ('space-1', 'review-model', 7)`
      const stored = yield* sql<{ readonly task_id: string }>`SELECT task_id FROM scheduled_tasks`
      const owner = yield* readWorkOwner(sql, spaceJobId("space-1"))
      // Zero is a valid cooldown (NonNegativeInt), kept as stored.
      yield* sql`UPDATE space_review_settings SET cooldown_minutes = 0 WHERE space_id = 'space-1'`
      return { stored, defaults, owner, zero: yield* readWorkOwner(sql, spaceJobId("space-1")) }
    })
  )
  expect(outcome.stored).toEqual([])
  expect(outcome.defaults).toMatchObject({
    kind: "space_review",
    settings: { model: null, cooldownMinutes: null, contextMode: "fresh" }
  })
  expect(outcome.owner).toMatchObject({
    kind: "space_review",
    spaceId: "space-1",
    name: "Made-up worker",
    settings: { model: "review-model", cooldownMinutes: 7, contextMode: "fresh" },
    mayRun: true
  })
  expect(outcome.zero).toMatchObject({ settings: { cooldownMinutes: 0 } })
  expect(outcome.owner).not.toHaveProperty("authored")
  for (const unused of ["handler", "triggers", "instructionRevisionId", "prompt"]) {
    expect(outcome.owner).not.toHaveProperty(["settings", unused])
  }
})
