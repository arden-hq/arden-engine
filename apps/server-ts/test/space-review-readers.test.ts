import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { spaceJobId } from "../src/persistence/space-job-id.js"
import { internalRef } from "../src/persistence/sqlite/space-jobs.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { freePage } from "./fixtures/free-space-page.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const REVIEW = spaceJobId("space-1")
const DUE = "2030-01-01T00:00:00.000Z"

const guardDefinitions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const event of ["INSERT", "UPDATE"])
    yield* sql.unsafe(`CREATE TRIGGER reject_synthetic_space_review_${event.toLowerCase()}
      BEFORE ${event} ON scheduled_tasks WHEN NEW.purpose = 'space_review'
      BEGIN SELECT RAISE(ABORT, 'reject_synthetic_space_review: a Space review definition row was written'); END`)
})

const readersCase = (poisoned: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const spaces = yield* SpaceStore
    const catalog = yield* AutomationCatalog
    const queue = yield* AutomationQueue
    yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
      VALUES ('space-1', 'Made-up', 'made-up', '{"enabled":true}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
    if (poisoned)
      yield* sql`INSERT INTO scheduled_tasks (task_id, automation_ref, name, description, prompt, context_mode,
          triggers, enabled, created_at, auto_approve, builtin, tool_scope, triggers_source, purpose,
          owner_space_id, next_run_at)
        VALUES (${REVIEW}, ${internalRef(REVIEW)}, 'Stale worker', 'Internal Space execution', 'Review it.',
          'fresh', '[]', 1, '2026-11-01T00:00:00.000Z', 1, 1, 'space', 'space_runtime', 'space_review',
          'space-1', ${DUE})`
    yield* guardDefinitions
    yield* spaces.bindPage("space-1", freePage("page-1", "projects/made-up.md"))
    yield* (yield* WorkStore).create(
      { kind: "space", spaceId: "space-1" },
      { key: "background", text: "In the background" }
    )
    const [space] = yield* sql<{ readonly updated_at: string }>`
      SELECT updated_at FROM spaces WHERE space_id = 'space-1'`
    yield* spaces.update("space-1", {
      name: "Renamed",
      expected_updated_at: space?.updated_at ?? ""
    })
    const [chat] = yield* sql<{ readonly session_id: string }>`
      SELECT session_id FROM space_review_chats WHERE space_id = 'space-1'`
    if (chat === undefined) throw new Error("The review has no private chat")

    const focused = yield* catalog.diagnostics(internalRef(REVIEW))
    const header = yield* (yield* SessionQueries).loadHeaderSnapshot(chat.session_id)
    const nextDue = yield* Effect.promise(async () =>
      queue.jobs.nextDueAt(Date.parse("2029-12-31T00:00:00.000Z"))
    )
    const leases = yield* Effect.promise(async () =>
      queue.jobs.claim({
        workerId: "late",
        now: Date.parse(DUE) + 60_000,
        limit: 10,
        leaseDurationMs: 60_000
      })
    )
    return {
      firstQueued: focused.queue[0]
        ? {
            task_id: focused.queue[0].task_id,
            name: focused.queue[0].name,
            session_id: focused.queue[0].session_id
          }
        : undefined,
      selected: focused.selected_automation_ref === internalRef(REVIEW),
      schedules: focused.schedules.map((row) => row.task_id),
      originJobPurpose: header?.header.originJobPurpose,
      nextDueIsOldRow: nextDue === Date.parse(DUE),
      scheduledLeases: leases.filter(
        (lease) => lease.payload.automationId === REVIEW && lease.payload.occurrence === "scheduled"
      ).length,
      scheduledRows: (yield* sql<{
        readonly n: number
      }>`SELECT COUNT(*) AS n FROM automation_event_queue
        WHERE task_id = ${REVIEW} AND source = 'scheduled'`)[0]?.n,
      oldRow:
        yield* sql`SELECT name, next_run_at FROM scheduled_tasks WHERE purpose = 'space_review'`
    }
  })

const expected = (oldRow: ReadonlyArray<unknown>) => ({
  firstQueued: { task_id: REVIEW, name: "Renamed worker", session_id: expect.any(String) },
  selected: true,
  schedules: [],
  originJobPurpose: "space_review",
  nextDueIsOldRow: false,
  scheduledLeases: 0,
  scheduledRows: 0,
  oldRow
})

it("a Space's last check is the latest counted run its review or Tasks completed", async () => {
  const lastChecked = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      for (const id of ["space-1", "space-2"])
        yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
          VALUES (${id}, ${id}, ${id}, '{"enabled":true}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
      const work = yield* WorkStore
      const mine = yield* work.create({ kind: "space", spaceId: "space-1" }, { text: "Mine" })
      const other = yield* work.create({ kind: "space", spaceId: "space-2" }, { text: "Other" })
      const run = (
        job: string,
        started: string,
        ended: string,
        status: string,
        outcome: string
      ) => sql`INSERT INTO automation_runs (task_id, automation_ref, started_at, ended_at, status, outcome)
        VALUES (${job}, ${job}, ${started}, ${ended}, ${status}, ${outcome})`
      const task = `task:${mine.item_id}`
      yield* run(
        REVIEW,
        "2026-11-02T00:00:00.000Z",
        "2026-11-02T01:00:00.000Z",
        "completed",
        "finished"
      )
      yield* run(
        task,
        "2026-11-02T23:00:00.000Z",
        "2026-11-03T00:00:00.000Z",
        "completed",
        "finished"
      )
      yield* run(
        task,
        "2026-11-04T00:00:00.000Z",
        "2026-11-04T01:00:00.000Z",
        "completed",
        "superseded"
      )
      yield* run(task, "2026-11-05T00:00:00.000Z", "2026-11-05T01:00:00.000Z", "failed", "failed")
      yield* run(
        `task:${other.item_id}`,
        "2026-11-06T00:00:00.000Z",
        "2026-11-06T01:00:00.000Z",
        "completed",
        "finished"
      )
      return (yield* spaces.detail("space-1"))?.agent?.last_checked
    })
  )
  expect(lastChecked).toBe("2026-11-03T00:00:00.000Z")
})

it("a Space's last check is the latest completion, even when a clock change reorders start times", async () => {
  const lastChecked = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
        VALUES ('space-1', 'space-1', 'space-1', '{"enabled":true}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
      for (const [started, ended] of [
        ["2026-11-20T10:00:10.000Z", "2026-11-20T10:00:01.000Z"],
        ["2026-11-20T10:00:02.000Z", "2026-11-20T10:00:03.000Z"]
      ])
        yield* sql`INSERT INTO automation_runs (task_id, automation_ref, started_at, ended_at, status, outcome)
          VALUES (${REVIEW}, ${REVIEW}, ${started}, ${ended}, 'completed', 'finished')`
      return (yield* spaces.detail("space-1"))?.agent?.last_checked
    })
  )
  expect(lastChecked).toBe("2026-11-20T10:00:03.000Z")
})

it("a review's reference, chat header and schedule come from its Space, with no old row", async () => {
  expect(await withTempDatabase(readersCase(false))).toEqual(expected([]))
})

it("a poisoned old review row is not a reference, a header, a schedule or a wake", async () => {
  expect(await withTempDatabase(readersCase(true))).toEqual(
    expected([{ name: "Stale worker", next_run_at: DUE }])
  )
})
