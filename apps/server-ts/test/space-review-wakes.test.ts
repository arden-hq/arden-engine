import { readdirSync, readFileSync } from "node:fs"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { wikiChangedEvent } from "../src/automations/producers/wiki.js"
import { automationWikiChangeSinkLayer } from "../src/automations/wiki-change-sink.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { spaceJobId } from "../src/persistence/space-job-id.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { WikiChangeSink } from "../src/wiki/publication.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// Which change wakes a Space review, from the source of each change. Memory pages alone start
// nothing, so a Memory save queues nothing; a Task change, Space settings and page binding wake.

const REVISION = "a".repeat(64)
const AT = "2026-11-01T00:00:00.000Z"

const space = (sql: SqlClient.SqlClient, spaceId: string, inference: boolean) =>
  sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
    VALUES (${spaceId}, ${`Made-up ${spaceId}`}, ${`made-up ${spaceId}`},
      ${JSON.stringify({ enabled: inference })}, ${AT}, ${AT})`

/** The queued review rows of one Space, each with the kinds of change that caused it. */
const reviewRows = (sql: SqlClient.SqlClient, spaceId: string) =>
  sql<{ readonly context: string; readonly next_attempt_at: string | null }>`
    SELECT context, next_attempt_at FROM automation_event_queue
    WHERE task_id = ${spaceJobId(spaceId)} ORDER BY id`.pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const snapshot = JSON.parse(row.context).trigger_context_snapshot
        const causes: ReadonlyArray<{ source: string; event_type?: string }> =
          snapshot.source === "coalesced" ? snapshot.causes : [snapshot]
        return {
          causes: causes.map((cause) => cause.event_type ?? cause.source),
          batched: row.next_attempt_at !== null
        }
      })
    )
  )

const clearQueue = (sql: SqlClient.SqlClient) => sql`DELETE FROM automation_event_queue`

it("a Memory save queues no Space review, through the wiki change path or a dispatch", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      const triggers = yield* AutomationTriggers
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      // A review job stored before Memory stopped waking reviews still subscribes to it.
      yield* sql`UPDATE scheduled_tasks
        SET triggers = '[{"type":"event","event_type":"wiki.changed","id":"t1"}]', trigger_last_id = 1
        WHERE purpose = 'space_review'`
      yield* spaces.update("space-1", { name: "Made-up Space again" })
      const jobs = yield* sql<{ readonly triggers: string }>`
        SELECT triggers FROM scheduled_tasks WHERE purpose = 'space_review'`
      yield* clearQueue(sql)
      const published = yield* Effect.gen(function* () {
        const sink = yield* WikiChangeSink
        yield* sink.cursor(null)
        return yield* sink.publish({
          previousRevision: null,
          revision: REVISION,
          savedAt: AT,
          paths: ["projects/made-up-space.md"],
          origin: { kind: "user", via: "desktop" },
          hasSpacePage: true
        })
      }).pipe(Effect.provide(automationWikiChangeSinkLayer))
      const dispatched = yield* triggers.dispatchEvent(
        wikiChangedEvent({
          paths: ["projects/made-up-space.md"],
          revision: "b".repeat(64),
          savedAt: AT,
          source: "user",
          hasSpacePage: true,
          producedBy: null,
          chainDepth: 0
        })
      )
      return {
        jobs: jobs.map((job) => job.triggers),
        published,
        dispatched,
        rows: yield* reviewRows(sql, "space-1")
      }
    })
  )
  expect(outcome.jobs).toEqual(["[]"])
  expect(outcome.published).toEqual({ queued: 0 })
  expect(outcome.dispatched).toEqual({ queued: 0 })
  expect(outcome.rows).toEqual([])
})

it("nothing on the wiki change path or in event dispatch can reach a Space review", () => {
  const src = new URL("../src/", import.meta.url)
  const read = (file: string) => readFileSync(new URL(file, src), "utf8")
  const wikiPath = [
    "automations/wiki-change-sink.ts",
    "automations/producers/wiki.ts",
    ...readdirSync(new URL("wiki/", src)).map((file) => `wiki/${file}`)
  ]
  for (const file of wikiPath.filter((name) => name.endsWith(".ts")))
    expect(read(file), file).not.toMatch(/space-jobs|queueSpaceWake|spaceJobId|space_review/)
  expect(read("persistence/sqlite/automation-event-dispatch.ts")).not.toMatch(/space_review/)
})

it("a Task change wakes its Space review once per burst, but not from the review's own writes", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      const triggers = yield* AutomationTriggers
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      // Suggestions on but no Memory page, and suggestions off: neither review can run.
      yield* space(sql, "space-2", true)
      yield* space(sql, "space-3", false)
      for (const spaceId of ["space-1", "space-2", "space-3"])
        yield* sql`INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner,
            created_at, updated_at)
          VALUES (${`task-${spaceId}`}, ${spaceId}, ${`key-${spaceId}`}, 'Made-up Task', 'open',
            'worker', ${AT}, ${AT})`
      yield* clearQueue(sql)
      let sequence = 0
      const taskEvent = (itemId: string, eventType: string, producedBy: string | null) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly event_id: number }>`
            INSERT INTO space_task_events (space_id, item_id, run_ref, operation_index, event_type,
              summary, content_kind, created_at)
            SELECT space_id, item_id, NULL, NULL, ${eventType}, 'Made-up change', 'summary', ${AT}
            FROM space_tasks WHERE item_id = ${itemId}
            RETURNING event_id`
          if (row === undefined) throw new Error("the Task event was not written")
          sequence += 1
          yield* triggers.applyTriggerFeedRecord({
            sequence,
            atMs: Date.parse(AT),
            kind: "other",
            sessionId: null,
            journal: {
              atMs: Date.parse(AT),
              event: {
                type: "task_history_added",
                item_id: itemId,
                event_id: row.event_id,
                produced_by: producedBy,
                chain_depth: producedBy === null ? 0 : 1
              }
            }
          })
        })
      // The review's own Task writes, and a retry being scheduled, wake nothing.
      yield* taskEvent("task-space-1", "updated", spaceJobId("space-1"))
      yield* taskEvent("task-space-1", "scheduled", null)
      const ownWrites = yield* reviewRows(sql, "space-1")
      // A burst of changes from the owner and the Task's worker makes one batched wake.
      yield* taskEvent("task-space-1", "updated", null)
      yield* taskEvent("task-space-1", "reported", "task:task-space-1")
      yield* taskEvent("task-space-1", "done", "task:task-space-1")
      yield* taskEvent("task-space-2", "done", null)
      yield* taskEvent("task-space-3", "done", null)
      return {
        ownWrites,
        burst: yield* reviewRows(sql, "space-1"),
        noPage: yield* reviewRows(sql, "space-2"),
        off: yield* reviewRows(sql, "space-3")
      }
    })
  )
  expect(outcome.ownWrites).toEqual([])
  expect(outcome.burst).toEqual([
    { causes: ["task.changed", "task.changed", "task.changed"], batched: true }
  ])
  expect(outcome.noPage).toEqual([])
  expect(outcome.off).toEqual([])
})

it("Space settings wake the review the same way whether the owner or Arden wrote them", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      yield* space(sql, "space-2", true)
      yield* clearQueue(sql)
      yield* spaces.setGeneratedInstructions("space-1", "Made-up drafted instructions.")
      const drafted = yield* reviewRows(sql, "space-1")
      yield* clearQueue(sql)
      yield* spaces.update("space-1", { instructions: "Made-up owner instructions." })
      const written = yield* reviewRows(sql, "space-1")
      yield* spaces.setGeneratedInstructions("space-2", "Made-up drafted instructions.")
      return { drafted, written, noPage: yield* reviewRows(sql, "space-2") }
    })
  )
  expect(outcome.drafted).toEqual([{ causes: ["space.wake"], batched: true }])
  expect(outcome.written).toEqual(outcome.drafted)
  expect(outcome.noPage).toEqual([])
})

it("binding the Space to another Memory page wakes the review", async () => {
  const rows = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      yield* spaces.detachPage("space-1")
      yield* clearQueue(sql)
      yield* spaces.bindPage("space-1", "page-2", "projects/another-made-up-space.md")
      return yield* reviewRows(sql, "space-1")
    })
  )
  expect(rows).toEqual([{ causes: ["space.wake"], batched: true }])
})
