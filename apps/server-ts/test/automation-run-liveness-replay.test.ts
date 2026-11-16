import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { wikiMaintenanceHandler } from "../src/automations/handlers/wiki-maintenance.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { locateReplayCopy, runOnReplayCopy } from "./fixtures/replay-copy.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const located = locateReplayCopy()
const MAINTENANCE = wikiMaintenanceHandler.spec.automationId

type Row = Record<string, unknown>

it("leaves no job run open without its job, and wakes Maintenance once, on the real history", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const copied = await runOnReplayCopy(
    located.copy,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [open] = yield* sql<{ readonly orphans: number; readonly held: number }>`SELECT
        (SELECT COUNT(*) FROM automation_runs AS run
          WHERE run.status = 'running' AND run.task_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM automation_event_queue AS queue
              WHERE json_extract(queue.context, '$.automation_run_id') = run.id)) AS orphans,
        (SELECT COUNT(*) FROM automation_event_queue AS queue
          WHERE queue.task_id = ${MAINTENANCE}
            AND EXISTS (SELECT 1 FROM automation_runs AS producer
              WHERE producer.status = 'running'
                AND producer.task_id = json_extract(queue.context, '$.trigger_context_snapshot.produced_by'))) AS held`
      const task = yield* sql<Row>`SELECT * FROM scheduled_tasks WHERE task_id = ${MAINTENANCE}`
      const waiting = yield* sql<Row>`SELECT * FROM automation_event_queue
        WHERE task_id = ${MAINTENANCE} ORDER BY id`
      const producers = yield* sql<Row>`SELECT * FROM automation_runs
        WHERE status = 'running' AND task_id IN (
          SELECT json_extract(context, '$.trigger_context_snapshot.produced_by')
          FROM automation_event_queue WHERE task_id = ${MAINTENANCE})`
      return { open, task, waiting, producers }
    })
  )
  const claimed = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const queue = yield* AutomationQueue
      for (const row of copied.task) yield* sql`INSERT INTO scheduled_tasks ${sql.insert(row)}`
      for (const row of copied.producers) yield* sql`INSERT INTO automation_runs ${sql.insert(row)}`
      for (const row of copied.waiting)
        yield* sql`INSERT INTO automation_event_queue ${sql.insert(row)}`
      const leases = yield* Effect.promise(async () =>
        queue.jobs.claim({ workerId: "replay", now: Date.now(), limit: 1, leaseDurationMs: 60_000 })
      )
      const [left] = yield* sql<{ readonly changes: number; readonly runs: number }>`SELECT
        (SELECT COUNT(*) FROM automation_event_queue
          WHERE task_id = ${MAINTENANCE} AND claimed_at IS NULL AND source = 'event') AS changes,
        (SELECT COUNT(*) FROM automation_runs
          WHERE task_id = ${MAINTENANCE} AND status = 'running') AS runs`
      return {
        leases: leases.map((lease) => [lease.payload.automationId, lease.payload.occurrence]),
        left
      }
    })
  )
  console.info(
    `Replay: ${copied.producers.length} running producer runs, ` +
      `${copied.waiting.length} waiting Maintenance rows, ` +
      `${copied.open?.orphans} job runs open without a job, ${copied.open?.held} rows held; ` +
      `after one claim ${claimed.left?.changes} change rows wait in ${claimed.left?.runs} running run.`
  )
  expect(copied.open).toEqual({ orphans: 0, held: 0 })
  expect(claimed).toEqual({
    leases: [[MAINTENANCE, "event"]],
    left: { changes: 0, runs: 1 }
  })
})
