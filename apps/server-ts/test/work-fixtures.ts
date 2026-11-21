import { errorMessage } from "@arden-hq/std/errors"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { spaceJobId } from "../src/persistence/space-job-id.js"
import { WorkStore } from "../src/persistence/work/store.js"

export const LATER = Date.now() + 60 * 60_000

const LEASE_MS = 60_000

export const claim = (workerId: string, limit: number, now = LATER) =>
  Effect.gen(function* () {
    const queue = yield* AutomationQueue
    return yield* Effect.promise(async () =>
      queue.jobs.claim({ workerId, now, limit, leaseDurationMs: LEASE_MS })
    )
  })

export type Lease = Effect.Success<ReturnType<typeof claim>>[number]

const attempted = <A>(call: () => Promise<A>) =>
  Effect.promise(async () =>
    call().then(
      (value) => ({ kind: "done" as const, value }),
      (error: unknown) => ({ kind: "refused" as const, message: errorMessage(error) })
    )
  )

export const tryClaim = (workerId: string, now: number) =>
  Effect.gen(function* () {
    const queue = yield* AutomationQueue
    return yield* attempted(async () =>
      queue.jobs.claim({ workerId, now, limit: 10, leaseDurationMs: LEASE_MS })
    )
  })

export const tryRenew = (lease: Lease, now: number) =>
  Effect.gen(function* () {
    const queue = yield* AutomationQueue
    return yield* attempted(async () =>
      queue.jobs.renew({ ...lease, workerId: "first", now, leaseDurationMs: LEASE_MS })
    )
  })

export const makeTask = Effect.gen(function* () {
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

export const makeAutomation = Effect.gen(function* () {
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
  return automation.task_id
})

export const storeUnderKey = (automationId: string, key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TEMP TABLE under_key AS
      SELECT * FROM scheduled_tasks WHERE task_id = ${automationId}`
    yield* sql`UPDATE under_key SET task_id = ${key}, automation_ref = automation_ref || '-under-key'`
    yield* sql`INSERT INTO scheduled_tasks SELECT * FROM under_key`
    yield* sql`DROP TABLE under_key`
    yield* sql`UPDATE sessions SET origin_automation_id = ${key}
      WHERE origin_automation_id = ${automationId}`
    yield* sql`UPDATE automation_event_queue SET task_id = ${key} WHERE task_id = ${automationId}`
  })

export const requestRun = (key: string) =>
  Effect.gen(function* () {
    yield* (yield* AutomationQueue).requestRun(AutomationId.make(key))
  })

export type AttemptCorruption =
  | { readonly kind: "purpose"; readonly purpose: string | null }
  | { readonly kind: "origin"; readonly origin: Readonly<Record<string, string>> }
  | { readonly kind: "unbound" }

export const corruptAttempt = (attemptId: number, change: AttemptCorruption) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP TRIGGER IF EXISTS automation_runs_immutable_context`
    switch (change.kind) {
      case "purpose":
        yield* sql`UPDATE automation_runs SET purpose = ${change.purpose} WHERE id = ${attemptId}`
        break
      case "origin":
        yield* sql`UPDATE automation_runs SET origin = ${JSON.stringify(change.origin)}
          WHERE id = ${attemptId}`
        break
      case "unbound":
        yield* sql`UPDATE automation_runs SET item_id = NULL, task_generation = NULL
          WHERE id = ${attemptId}`
        break
    }
  })
