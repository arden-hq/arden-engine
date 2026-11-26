import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { wikiMaintenanceHandler } from "../src/automations/handlers/wiki-maintenance.js"
import { wikiChangedEvent } from "../src/automations/producers/wiki.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { newAutomation, everyTrigger } from "./fixtures/automation-input.js"

const MAINTENANCE = wikiMaintenanceHandler.spec.automationId

const userAutomation = (key: string) =>
  Effect.gen(function* () {
    const catalog = yield* AutomationCatalog
    const queue = yield* AutomationQueue
    const automation = yield* catalog.create(
      newAutomation({
        history: "chat",
        name: "Liveness",
        prompt: "Review",
        triggers: [everyTrigger("1h")],
        idempotency_key: key
      }),
      "owner"
    )
    yield* queue.requestRun(AutomationId.make(automation.task_id))
    return automation
  })

const claim = (now: number) =>
  Effect.gen(function* () {
    const queue = yield* AutomationQueue
    return yield* Effect.promise(async () =>
      queue.jobs.claim({
        workerId: "liveness",
        now,
        limit: 1,
        leaseDurationMs: 30_000
      })
    )
  })

const runRow = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      readonly status: string
      readonly outcome: string | null
      readonly error: string | null
      readonly ended: number
      readonly claim_count: number
    }>`SELECT status, outcome, error, ended_at IS NOT NULL AS ended, claim_count
      FROM automation_runs WHERE id = ${id}`
    return rows[0]
  })

const runningRuns = (automationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ readonly id: number }>`SELECT id FROM automation_runs
      WHERE task_id = ${automationId} AND status = 'running'`
  })

const interrupted = (claimCount: number) => ({
  status: "interrupted",
  outcome: "interrupted",
  error: expect.any(String),
  ended: 1,
  claim_count: claimCount
})

it("closes a run whose queue row is deleted without settlement", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const automation = yield* userAutomation("0b6a3d1e-3a52-4d0e-8f43-1f7fb0a3c001")
      const [lease] = yield* claim(Date.now())
      if (lease === undefined) return yield* Effect.die("Expected a lease")
      yield* sql`DELETE FROM automation_event_queue WHERE id = ${Number(lease.id)}`
      expect(yield* runRow(lease.payload.automationRunId)).toEqual(interrupted(1))
      expect(
        yield* sql`SELECT job_held_since FROM scheduled_tasks WHERE task_id = ${automation.task_id}`
      ).toEqual([{ job_held_since: null }])
    })
  )
})

it("refuses to remove an Automation during its chat run after its job is released, and keeps the run", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const chat = yield* ChatWriteStore
      const automation = yield* userAutomation("0b6a3d1e-3a52-4d0e-8f43-1f7fb0a3c003")
      const now = Date.now()
      const [lease] = yield* claim(now)
      if (lease === undefined || lease.payload.sessionId === null)
        return yield* Effect.die("Expected a lease with a chat")
      yield* chat.start({
        sessionId: lease.payload.sessionId,
        clientId: "removed",
        requestHash: "removed",
        assistantMessageId: "removed:assistant",
        automationLease: { id: lease.id, token: lease.token },
        automation: {
          automationId: AutomationId.make(automation.task_id),
          name: automation.name,
          attemptId: lease.payload.automationRunId
        },
        automationContextMode: "continue",
        automationPrompt: "Review",
        message: {
          message_id: "removed",
          client_id: "removed",
          role: ROLE.interaction,
          kind: "assignment",
          from: {
            source: "automation",
            id: automation.task_id,
            name: automation.name
          },
          content: "Review",
          created_at: new Date(now).toISOString(),
          automation: {
            context_mode: "continue",
            task_id: automation.task_id,
            name: automation.name,
            prompt: "Review"
          }
        }
      })
      yield* Effect.promise(async () =>
        Promise.resolve(queue.jobs.release({ ...lease, releasedAt: now + 1_000 }))
      )
      const refused = yield* catalog.delete(AutomationId.make(automation.task_id)).pipe(Effect.flip)
      expect(refused.reason).toBe("conflict")
      expect(yield* runningRuns(automation.task_id)).toEqual([
        { id: lease.payload.automationRunId }
      ])
    })
  )
})

it("takes every waiting Memory change into one Maintenance run, and leaves its timer", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const triggers = yield* AutomationTriggers
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      for (const revision of ["revision-1", "revision-2", "revision-3"])
        yield* triggers.dispatchEvent(
          wikiChangedEvent({
            paths: [`${revision}.md`],
            revision,
            savedAt: new Date().toISOString(),
            source: "user",
            hasSpacePage: false,
            producedBy: null,
            chainDepth: 0
          })
        )
      yield* sql`UPDATE scheduled_tasks SET next_run_at = ${new Date(Date.now() - 60_000).toISOString()}
        WHERE task_id = ${MAINTENANCE}`
      const leases = yield* claim(Date.now())
      expect(leases.map((lease) => [lease.payload.automationId, lease.payload.occurrence])).toEqual(
        [[MAINTENANCE, "event"]]
      )
      expect(
        yield* sql`SELECT source FROM automation_event_queue
          WHERE task_id = ${MAINTENANCE} AND claimed_at IS NULL`
      ).toEqual([{ source: "scheduled" }])
      expect(
        yield* sql`SELECT json_extract(cause.value, '$.event_key') AS event_key
          FROM automation_runs AS run, json_each(run.trigger_json, '$.causes') AS cause
          WHERE run.task_id = ${MAINTENANCE} ORDER BY event_key`
      ).toEqual([
        { event_key: "revision-1" },
        { event_key: "revision-2" },
        { event_key: "revision-3" }
      ])
    })
  )
})

it("keeps one run open across restart, retry and release, and settles it once", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const queue = yield* AutomationQueue
      const automation = yield* userAutomation("0b6a3d1e-3a52-4d0e-8f43-1f7fb0a3c006")
      const now = Date.now()
      const [first] = yield* claim(now)
      if (first === undefined) return yield* Effect.die("Expected a lease")
      const runId = first.payload.automationRunId
      yield* Effect.promise(async () => Promise.resolve(queue.jobs.recoverExpired(now)))
      const [restarted] = yield* claim(first.expiresAt)
      expect([restarted?.payload.automationRunId, restarted?.attempt]).toEqual([runId, 2])
      if (restarted === undefined) return
      yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.fail({
            ...restarted,
            failedAt: first.expiresAt,
            error: "Try again",
            retryAt: first.expiresAt + 1_000
          })
        )
      )
      expect(yield* runRow(runId)).toMatchObject({
        status: "running",
        claim_count: 2
      })
      const [retried] = yield* claim(first.expiresAt + 1_000)
      if (retried === undefined) return yield* Effect.die("Expected the retry")
      yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.release({
            ...retried,
            releasedAt: first.expiresAt + 1_000
          })
        )
      )
      const [released] = yield* claim(first.expiresAt + 2_000)
      if (released === undefined) return yield* Effect.die("Expected the released job")
      expect(released.payload.automationRunId).toBe(runId)
      yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.complete({
            ...released,
            completedAt: first.expiresAt + 3_000,
            result: {
              status: "ended",
              outcome: "finished",
              result: "Done",
              error: null,
              chatRunId: null,
              chatSessionId: null
            }
          })
        )
      )
      expect(yield* runRow(runId)).toEqual({
        status: "completed",
        outcome: "finished",
        error: null,
        ended: 1,
        claim_count: 4
      })
      expect(
        yield* sql`SELECT id FROM automation_event_queue WHERE task_id = ${automation.task_id}`
      ).toEqual([])
    })
  )
})
