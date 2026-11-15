import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { memoryCaptureHandler } from "../src/automations/handlers/memory-capture.js"
import { wikiMaintenanceHandler } from "../src/automations/handlers/wiki-maintenance.js"
import { wikiChangedEvent } from "../src/automations/producers/wiki.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { SpaceReviewStore } from "../src/persistence/automations/space-review-store.js"
import { buildSpaceReviewInput } from "../src/automations/space-review-input.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// A claim folds a waiting event into its run only when that event could start
// a run of its own now at the run's chain depth. Both folding paths, Wiki
// Maintenance and a user's Automation, keep to that one rule.

const CAPTURE = memoryCaptureHandler.spec.automationId
const MAINTENANCE = wikiMaintenanceHandler.spec.automationId

const claim = (now: number) =>
  Effect.gen(function* () {
    const queue = yield* AutomationQueue
    return yield* Effect.promise(async () =>
      queue.jobs.claim({ workerId: "folding", now, limit: 1, leaseDurationMs: 30_000 })
    )
  })

const change = (revision: string, producedBy: string | null) =>
  Effect.gen(function* () {
    const triggers = yield* AutomationTriggers
    yield* triggers.dispatchEvent(
      wikiChangedEvent({
        paths: [`${revision}.md`],
        revision,
        savedAt: new Date().toISOString(),
        source: producedBy === null ? "user" : "automation",
        hasSpacePage: false,
        producedBy,
        chainDepth: producedBy === null ? 0 : 1
      })
    )
  })

const listener = (key: string, eventType: "wiki.changed" | "task.changed" = "wiki.changed") =>
  Effect.gen(function* () {
    const catalog = yield* AutomationCatalog
    const created = yield* catalog.create(
      {
        history: "fresh",
        name: `Listener ${key.slice(-1)}`,
        prompt: "Review the change",
        triggers: [{ type: "event", event_type: eventType }],
        idempotency_key: key,
        idempotency_scope: "global"
      },
      "owner"
    )
    return created.task_id
  })

/** The run's causes and the rows of the Automation still waiting. */
const folded = (automationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const causes = yield* sql<{ readonly source: string; readonly event_key: string | null }>`
      SELECT json_extract(cause.value, '$.source') AS source,
        json_extract(cause.value, '$.event_key') AS event_key
      FROM automation_runs AS run,
        json_each(CASE json_extract(run.trigger_json, '$.source')
          WHEN 'coalesced' THEN json_extract(run.trigger_json, '$.causes')
          ELSE json_array(json(run.trigger_json)) END) AS cause
      WHERE run.task_id = ${automationId} ORDER BY cause.key`
    const waiting = yield* sql<{ readonly source: string; readonly event_key: string | null }>`
      SELECT source, json_extract(context, '$.trigger_context_snapshot.event_key') AS event_key
      FROM automation_event_queue
      WHERE task_id = ${automationId} AND claimed_at IS NULL ORDER BY id`
    return { causes, waiting }
  })

it("Maintenance folds no Memory change deeper than its run", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      const producer = yield* listener("5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7a01", "task.changed")
      yield* change("revision-1", null)
      yield* change("revision-2", producer)
      const [lease] = yield* claim(Date.now())
      expect(lease?.payload.automationId).toBe(MAINTENANCE)
      expect(yield* folded(MAINTENANCE)).toEqual({
        causes: [{ source: "event", event_key: "revision-1" }],
        waiting: [{ source: "event", event_key: "revision-2" }]
      })
    })
  )
})

it("Maintenance folds no Memory change held behind its running producer", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      yield* catalog.seedSystemAutomations([memoryCaptureHandler.spec, wikiMaintenanceHandler.spec])
      const producer = yield* listener("5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7a02")
      yield* queue.requestRun(CAPTURE)
      const [capture] = yield* claim(Date.now())
      expect(capture?.payload.automationId).toBe(CAPTURE)
      yield* change("revision-1", producer)
      yield* change("revision-2", CAPTURE)
      const [lease] = yield* claim(Date.now())
      expect(lease?.payload.automationId).toBe(MAINTENANCE)
      expect(yield* folded(MAINTENANCE)).toEqual({
        causes: [{ source: "event", event_key: "revision-1" }],
        waiting: [{ source: "event", event_key: "revision-2" }]
      })
    })
  )
})

it("a user's Automation folds no event held behind its running producer", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      yield* catalog.seedSystemAutomations([memoryCaptureHandler.spec])
      const producer = yield* listener("5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7a03")
      const automation = yield* listener("5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7a04")
      yield* queue.requestRun(CAPTURE)
      const [capture] = yield* claim(Date.now())
      expect(capture?.payload.automationId).toBe(CAPTURE)
      yield* change("revision-1", producer)
      yield* change("revision-2", CAPTURE)
      const [lease] = yield* claim(Date.now())
      expect(lease?.payload.automationId).toBe(automation)
      expect(yield* folded(automation)).toEqual({
        causes: [{ source: "event", event_key: "revision-1" }],
        waiting: [{ source: "event", event_key: "revision-2" }]
      })
    })
  )
})

it("a run asked for by hand folds no event deeper than itself", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const queue = yield* AutomationQueue
      const producer = yield* listener("5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7a05", "task.changed")
      const automation = yield* listener("5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7a06")
      yield* queue.requestRun(AutomationId.make(automation))
      yield* change("revision-1", null)
      yield* change("revision-2", producer)
      const [lease] = yield* claim(Date.now())
      expect(lease?.payload.automationId).toBe(automation)
      const { causes, waiting } = yield* folded(automation)
      expect({ causes: causes.map((cause) => cause.event_key), waiting }).toEqual({
        causes: [null, "revision-1"],
        waiting: [{ source: "event", event_key: "revision-2" }]
      })
    })
  )
})

/** Makes a listener a Space's review job, which batches what waits for it in a window, then
 * runs. No Space review listens to events, so the events are queued while it is still a
 * listener; the fold rule at claim is the same for whatever waits in a review's queue. */
const asReview = (automation: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE scheduled_tasks SET purpose = 'space_review', owner_space_id = 'space-1' WHERE task_id = ${automation}`
  })

const AFTER_WINDOW = 31 * 60_000

it("a batch-window run folds no event held behind its running producer", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      yield* catalog.seedSystemAutomations([memoryCaptureHandler.spec])
      const automation = yield* listener("5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7a07")
      yield* queue.requestRun(CAPTURE)
      const [capture] = yield* Effect.promise(async () =>
        queue.jobs.claim({
          workerId: "folding",
          now: Date.now(),
          limit: 1,
          leaseDurationMs: 3_600_000
        })
      )
      expect(capture?.payload.automationId).toBe(CAPTURE)
      yield* change("revision-1", null)
      yield* change("revision-2", CAPTURE)
      yield* asReview(automation)
      const [lease] = yield* claim(Date.now() + AFTER_WINDOW)
      expect(lease?.payload.automationId).toBe(automation)
      expect(yield* folded(automation)).toEqual({
        causes: [{ source: "event", event_key: "revision-1" }],
        waiting: [{ source: "event", event_key: "revision-2" }]
      })
    })
  )
})

it("a batch-window run folds no event deeper than itself, nor one not yet due", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const producer = yield* listener("5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7a08", "task.changed")
      const automation = yield* listener("5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7a09")
      yield* change("revision-1", null)
      yield* change("revision-2", producer)
      yield* change("revision-3", null)
      yield* asReview(automation)
      const later = new Date(Date.now() + 2 * AFTER_WINDOW).toISOString()
      yield* sql`UPDATE automation_event_queue SET next_attempt_at = ${later}
        WHERE task_id = ${automation}
          AND json_extract(context, '$.trigger_context_snapshot.event_key') = 'revision-3'`
      const [lease] = yield* claim(Date.now() + AFTER_WINDOW)
      expect(lease?.payload.automationId).toBe(automation)
      expect(yield* folded(automation)).toEqual({
        causes: [{ source: "event", event_key: "revision-1" }],
        waiting: [
          { source: "event", event_key: "revision-2" },
          { source: "event", event_key: "revision-3" }
        ]
      })
    })
  )
})

// No path queues a manual row for a Space review today (Run now refuses one, a
// proposal recheck runs alone), so the row is written directly: whatever folds a
// manual cause into a review's run, the review counts as asked.
it("a manual row folded into an older Space review row still counts as asked", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const reviews = yield* SpaceReviewStore
      const at = new Date().toISOString()
      yield* sql`INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
        VALUES ('space-1', 'Space', 'space', ${at}, ${at})`
      const automation = yield* listener("5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7a0a")
      yield* change("revision-1", null)
      yield* asReview(automation)
      yield* sql`INSERT INTO automation_event_queue (task_id, source, event_key, context, created_at,
          claimed_at, attempt_count, last_error, next_attempt_at)
        VALUES (${automation}, 'manual', 'manual-1', '{"scheduled_for":null,"automation_run_id":null}',
          ${new Date(Date.now() + 1).toISOString()}, NULL, 0, NULL, NULL)`
      const [lease] = yield* claim(Date.now() + AFTER_WINDOW)
      expect(lease?.payload.automationId).toBe(automation)
      expect(lease?.payload.occurrence).toBe("event")
      expect((yield* folded(automation)).waiting).toEqual([])
      if (lease === undefined) return
      let asked: boolean | undefined
      yield* reviews.prepareSpaceReview(lease, (evidence) => {
        asked = evidence.asked
        return buildSpaceReviewInput({ head: null, pages: [] })(evidence)
      })
      expect(asked).toBe(true)
    })
  )
})
