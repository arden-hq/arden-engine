import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { spaceJobId, taskJobId } from "../src/persistence/space-job-id.js"
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

const makeAutomation = Effect.gen(function* () {
  const automation = yield* (yield* AutomationCatalog).create(
    {
      history: "chat",
      name: "Authored",
      prompt: "Review",
      triggers: [{ type: "time", every: "1h" }],
      idempotency_key: "88888888-8888-4888-8888-888888888888",
      idempotency_scope: "global"
    },
    "owner"
  )
  yield* (yield* AutomationQueue).requestRun(AutomationId.make(automation.task_id))
  return automation.task_id
})

const EARLY = "2026-11-02T00:00:00.000Z"
const LATE = "2026-11-03T00:00:00.000Z"

it.each([
  ["the Automation is earlier", "task", EARLY, LATE, "automation"],
  ["the Task is earlier", "task", LATE, EARLY, "task"],
  ["a tie, the Task queued first", "task", EARLY, EARLY, "task"],
  ["a tie, the Automation queued first", "automation", EARLY, EARLY, "automation"]
] as const)(
  "one claim takes the earliest wake of any owner: %s",
  async (_name, queuedFirst, automationAt, taskAt, winner) => {
    const outcome = await withTempDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const automationId = queuedFirst === "automation" ? yield* makeAutomation : null
        const task = yield* makeTask
        const authored = automationId ?? (yield* makeAutomation)
        const key = taskJobId(task.item_id)
        yield* sql`UPDATE automation_event_queue SET created_at = ${automationAt} WHERE task_id = ${authored}`
        yield* sql`UPDATE automation_event_queue SET created_at = ${taskAt} WHERE task_id = ${key}`
        const rows = yield* sql<{ readonly task_id: string }>`
          SELECT task_id FROM automation_event_queue ORDER BY id`
        const first = yield* claim("first", 1)
        const second = yield* claim("second", 1)
        const name = (id: string | undefined) => {
          if (id === authored) return "automation"
          return id === key ? "task" : id
        }
        return {
          queued: rows.map((row) => name(row.task_id)),
          first: first.map((lease) => name(lease.payload.automationId)),
          second: second.map((lease) => name(lease.payload.automationId)),
          definitions: yield* sql`SELECT task_id FROM scheduled_tasks WHERE task_id = ${key}`
        }
      })
    )
    const other = winner === "task" ? "automation" : "task"
    expect(outcome).toEqual({
      queued: queuedFirst === "task" ? ["task", "automation"] : ["automation", "task"],
      first: [winner],
      second: [other],
      definitions: []
    })
  }
)

it("a Task's older second wake waits for its running one, and does not hold an Automation back", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const queue = yield* AutomationQueue
      const task = yield* makeTask
      const key = taskJobId(task.item_id)
      const [running] = yield* claim("first", 10)
      if (running === undefined) throw new Error("The Task was not claimed")
      yield* (yield* WorkStore).update({ kind: "item", itemId: task.item_id }, task.updated_at, {
        text: "In the background, edited"
      })
      const waiting =
        yield* sql`UPDATE automation_event_queue SET created_at = '2020-01-01T00:00:00.000Z'
        WHERE task_id = ${key} AND claimed_at IS NULL RETURNING id`
      if (waiting.length !== 1) throw new Error(`Expected one waiting wake, got ${waiting.length}`)
      const authored = yield* makeAutomation
      const whileRunning = yield* claim("second", 10)
      const ofTask = (leases: Effect.Success<ReturnType<typeof claim>>) =>
        leases.filter((lease) => lease.payload.automationId === key)
      const afterExpiry = ofTask(yield* claim("third", 10, running.expiresAt + 1))
      const [reclaimed] = afterExpiry
      if (reclaimed === undefined) throw new Error("The expired claim did not come back")
      yield* Effect.promise(async () =>
        queue.jobs.release({ ...reclaimed, releasedAt: running.expiresAt + 2 })
      )
      const afterRelease = ofTask(yield* claim("fourth", 10, running.expiresAt + 10 * 60_000))
      return {
        first: running.payload.automationId === key,
        whileRunning: whileRunning.map((lease) => lease.payload.automationId === authored),
        afterExpiry: afterExpiry.map((lease) => [
          lease.id === running.id,
          lease.payload.automationRunId === running.payload.automationRunId,
          lease.attempt === running.attempt + 1
        ]),
        afterRelease: afterRelease.length,
        definitions: yield* sql`SELECT task_id FROM scheduled_tasks WHERE task_id = ${key}`
      }
    })
  )
  expect(outcome).toEqual({
    first: true,
    whileRunning: [true],
    afterExpiry: [[true, true, true]],
    afterRelease: 1,
    definitions: []
  })
})

it("ending a Task closes its claimed attempt before a run starts, and the old claim is refused", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const queue = yield* AutomationQueue
      const work = yield* WorkStore
      const task = yield* makeTask
      const key = taskJobId(task.item_id)
      const [lease] = yield* claim("first", 10)
      if (lease === undefined) throw new Error("The Task was not claimed")
      const before = yield* sql<{ readonly status: string }>`
        SELECT status FROM automation_runs WHERE id = ${lease.payload.automationRunId}`
      yield* work.update({ kind: "item", itemId: task.item_id }, task.updated_at, {
        status: "done"
      })
      const after = yield* sql<{ readonly status: string }>`
        SELECT status FROM automation_runs WHERE id = ${lease.payload.automationRunId}`
      const prepared = yield* queue.prepareRunSession(lease).pipe(Effect.result)
      const renewed = yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.renew({
            ...lease,
            workerId: "first",
            now: LATER + 1_000,
            leaseDurationMs: 60_000
          })
        ).then(
          () => "renewed",
          () => "refused"
        )
      )
      const [rows] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM automation_event_queue WHERE task_id = ${key}`
      return {
        before: before.map((row) => row.status),
        after: after.map((row) => row.status === "running"),
        prepared: prepared._tag,
        renewed,
        queued: rows?.n,
        again: (yield* claim("second", 10, LATER + 10 * 60_000)).length
      }
    })
  )
  expect(outcome).toEqual({
    before: ["running"],
    after: [false],
    prepared: "Failure",
    renewed: "refused",
    queued: 0,
    again: 0
  })
})
