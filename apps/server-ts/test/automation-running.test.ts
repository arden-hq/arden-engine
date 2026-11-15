import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { automationsOfChat } from "../src/persistence/sqlite/automation-removal.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// "Is this Automation running" has two meanings, each read in one place
// (automation-running.ts): a run of it is open, which is what a person and the
// model are told, and a worker holds its job now, which only the queue asks.

const SOURCE = join(import.meta.dirname, "../src")

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

/** The queue writes the job hold at claim and clears it at settlement; the
 * reader module is the one place anything else asks it. */
const JOB_HOLD_OWNERS = [
  "persistence/schema/sections/automation.ts",
  "persistence/sqlite/automation-job-settlement.ts",
  "persistence/sqlite/automation-jobs.ts",
  "persistence/sqlite/automation-running.ts"
]

it("reads the job hold only in its owners", () => {
  const readers = sources(SOURCE)
    .map((path) => relative(SOURCE, path))
    .filter((path) => !path.startsWith("persistence/migrations/"))
    .filter((path) => /\bjob_held_since\b/u.test(readFileSync(join(SOURCE, path), "utf8")))
  expect(readers).toEqual(JOB_HOLD_OWNERS)
})

/** Each file that tests an Automation run's status for 'running', with how
 * often. Every one of these names one particular run (by id, chat, origin or
 * item) or is the reader itself; whether an Automation is running is asked
 * only through openRunSince. A new count here is a second copy of that rule
 * unless it names one run. */
const RUN_STATUS_READERS = {
  "persistence/schema/sections/automation.ts": 3,
  "persistence/sqlite/automation-authority.ts": 1,
  "persistence/sqlite/automation-followup.ts": 1,
  "persistence/sqlite/automation-fork-session.ts": 1,
  "persistence/sqlite/automation-handler-item.ts": 1,
  "persistence/sqlite/automation-home-input.ts": 1,
  "persistence/sqlite/automation-job-settlement.ts": 1,
  "persistence/sqlite/automation-jobs.ts": 5,
  "persistence/sqlite/automation-lease.ts": 1,
  "persistence/sqlite/automation-rows.ts": 1,
  "persistence/sqlite/automation-run-outcome.ts": 2,
  "persistence/sqlite/automation-run-requests.ts": 1,
  "persistence/sqlite/automation-running.ts": 1,
  "persistence/sqlite/chat-work.ts": 2,
  "persistence/sqlite/run-context.ts": 2,
  "persistence/sqlite/run-ending.ts": 1,
  "persistence/sqlite/run-policy.ts": 1,
  "persistence/sqlite/space-job-recovery.ts": 1,
  "persistence/sqlite/space-review.ts": 3,
  "persistence/sqlite/task-next-move.ts": 1,
  "persistence/sqlite/work-retention.ts": 1
}

it("asks whether an Automation is running only through openRunSince", () => {
  const counts = Object.fromEntries(
    sources(SOURCE)
      .map((path) => relative(SOURCE, path))
      .filter((path) => !path.startsWith("persistence/migrations/"))
      .flatMap((path) => {
        const text = readFileSync(join(SOURCE, path), "utf8")
        if (!/\bautomation_runs\b/u.test(text)) return []
        const count = text.match(/status\s*=\s*'running'/gu)?.length ?? 0
        return count === 0 ? [] : [[path, count] as const]
      })
  )
  expect(counts).toEqual(RUN_STATUS_READERS)
})

it("keeps no stored column named running_since, so no reader can take it for a run", async () => {
  const columns = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('scheduled_tasks') WHERE name LIKE '%_since'`
    })
  )
  expect(columns).toEqual([{ name: "job_held_since" }])
})

it("an Automation whose job failed and waits for a retry is running, and stays", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const automation = yield* catalog.create(
        {
          history: "chat",
          name: "Retrying",
          prompt: "Review",
          triggers: [{ type: "time", every: "1h" }],
          idempotency_key: "7c1e5b3a-2d4f-4a6b-8c9d-0e1f2a3b4c01",
          idempotency_scope: "global"
        },
        "owner"
      )
      const id = AutomationId.make(automation.task_id)
      yield* queue.requestRun(id)
      const now = Date.now()
      const [lease] = yield* Effect.promise(async () =>
        queue.jobs.claim({ workerId: "running", now, limit: 1, leaseDurationMs: 30_000 })
      )
      if (lease === undefined) return yield* Effect.die("Expected a lease")
      yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.fail({ ...lease, failedAt: now, error: "Try again", retryAt: now + 60_000 })
        )
      )
      const [run] = yield* sql<{ readonly started_at: string }>`
        SELECT started_at FROM automation_runs WHERE id = ${lease.payload.automationRunId}`
      expect((yield* catalog.get(id))?.running_since).toBe(run?.started_at)
      const refused = yield* catalog.delete(id).pipe(Effect.flip)
      expect([refused.reason, refused.message]).toEqual([
        "conflict",
        "A running Automation cannot be deleted"
      ])
    })
  )
})

it("an Automation waiting for a retry keeps its chat, and its chat cannot be deleted under it", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const sessions = yield* SessionStore
      const chat = yield* sessions.create({ name: "Conversation" })
      const automation = yield* catalog.create(
        {
          history: "chat",
          name: "Retrying",
          prompt: "Review",
          triggers: [{ type: "time", every: "1h" }],
          chat: { kind: "yours", session_id: chat.sessionId },
          idempotency_key: "7c1e5b3a-2d4f-4a6b-8c9d-0e1f2a3b4c02",
          idempotency_scope: "global"
        },
        "owner"
      )
      const id = AutomationId.make(automation.task_id)
      yield* queue.requestRun(id)
      const now = Date.now()
      const [lease] = yield* Effect.promise(async () =>
        queue.jobs.claim({ workerId: "running", now, limit: 1, leaseDurationMs: 30_000 })
      )
      if (lease === undefined) return yield* Effect.die("Expected a lease")
      yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.fail({ ...lease, failedAt: now, error: "Try again", retryAt: now + 60_000 })
        )
      )
      expect(yield* automationsOfChat(sql, chat.sessionId)).toEqual([
        { task_id: automation.task_id, name: "Retrying", running: 1 }
      ])
      const refused = yield* catalog
        .update(id, { chat: { kind: "own" } }, "owner")
        .pipe(Effect.flip)
      expect([refused.reason, refused.message]).toEqual([
        "conflict",
        "Wait for the current Automation run before changing its chat"
      ])
    })
  )
})
