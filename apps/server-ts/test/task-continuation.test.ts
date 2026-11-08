import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { readSpaceJobContext } from "../src/persistence/sqlite/space-job-context.js"
import { makeSpaceJobSql } from "../src/persistence/sqlite/space-jobs.js"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { inUnitOfWork } from "./fixtures/unit-of-work.js"
import { taskJobId } from "../src/persistence/space-job-id.js"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.parse("2026-10-02T00:00:00.000Z")
const BOOKED = NOW + 24 * HOUR

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW })
})

afterAll(() => {
  vi.useRealTimers()
})
const at = (offset: number) => new Date(BOOKED + offset).toISOString()

it("persists the state record atomically, keeps it out of public updates, and rejects stale edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-task-continuation-"))
  const filename = join(directory, "arden.db")
  const storage = () =>
    Layer.merge(
      recoveredSqlitePersistenceLayer({ dataDir: null, filename }).pipe(
        Layer.provide(PersistenceWriteQueue.layer)
      ),
      SqliteClient.layer({ filename })
    )
  const context = {
    in_progress: [{ what: "Airline reply on the missed connection", handle: "case A7" }],
    decided: ["No paid change without approval"]
  }
  const record = { done: [], rejected: [], next: [], ...context }
  try {
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const spaces = yield* SpaceStore
        const work = yield* WorkStore
        const sql = yield* SqlClient.SqlClient
        const space = yield* spaces.create({ name: "Travel" })
        const task = yield* work.create(
          { kind: "space", spaceId: space.space_id },
          {
            key: "connection",
            text: "Resolve missed connection"
          }
        )
        expect(yield* work.execution(task.item_id)).toEqual({ kind: "queued" })
        const before = yield* work.page({ itemId: task.item_id })
        const updated = yield* work.update(
          { kind: "key", scope: { kind: "space", spaceId: space.space_id }, key: task.stable_key },
          task.updated_at,
          {
            continuation_context: context
          }
        )
        const after = yield* work.page({ itemId: task.item_id })
        expect(after.events).toEqual(before.events)
        expect(after.comments).toEqual(before.comments)
        expect(after.items[0]).not.toHaveProperty("continuation_context")
        expect(updated.updated_at).not.toBe(task.updated_at)
        expect(updated).not.toHaveProperty("continuation_context")
        expect(yield* work.execution(task.item_id)).toEqual({ kind: "queued" })
        const stale = yield* work
          .update(
            {
              kind: "key",
              scope: { kind: "space", spaceId: space.space_id },
              key: task.stable_key
            },
            task.updated_at,
            {
              continuation_context: { next: ["stale"] },
              due_at: at(HOUR)
            }
          )
          .pipe(Effect.flip)
        expect(stale.reason).toBe("conflict")
        expect(
          yield* sql`SELECT json_extract(continuation_context, '$.next') AS next, due_at FROM space_tasks WHERE item_id = ${task.item_id}`
        ).toEqual([{ next: "[]", due_at: null }])
        yield* spaces.bindPage(space.space_id, "travel-page", "spaces/travel.md")
        expect(yield* work.execution(task.item_id)).toEqual({ kind: "queued" })
        const dated = yield* work.update(
          { kind: "key", scope: { kind: "space", spaceId: space.space_id }, key: task.stable_key },
          updated.updated_at,
          {
            due_at: "end of next week",
            next_attempt_at: at(0)
          }
        )
        expect(yield* work.execution(task.item_id)).toEqual({
          kind: "scheduled",
          at: at(0)
        })
        const queue = yield* AutomationQueue
        const leases = yield* Effect.promise(async () =>
          queue.jobs.claim({
            workerId: "early",
            now: Date.parse(at(-HOUR)),
            limit: 10,
            leaseDurationMs: 30_000
          })
        )
        expect(leases.some((lease) => lease.payload.automationId === taskJobId(task.item_id))).toBe(
          false
        )
        yield* sql`DELETE FROM automation_event_queue WHERE task_id = ${taskJobId(task.item_id)}`
        return dated
      }).pipe(Effect.provide(storage()))
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const work = yield* WorkStore
        const snapshot = yield* readSpaceJobContext(sql, taskJobId(saved.item_id))
        if (snapshot?.kind !== "task_execution" || snapshot.task === undefined)
          throw new Error("Task snapshot missing")
        expect({
          context: snapshot.task.state?.record,
          due: snapshot.task.dueAt,
          next: snapshot.task.nextAttemptAt
        }).toMatchObject({
          context: record,
          due: "end of next week",
          next: at(0)
        })
        const metadata = JSON.stringify({
          run_context: { task: { item_id: saved.item_id, generation: 0 } }
        })
        yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type)
          VALUES ('answer-chat', 'answer-ref', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z', 'chat')`
        yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, metadata_json, assistant_message_id, ended_at)
          VALUES ('answer-run', 'answer-chat', 'completed', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z', ${metadata}, 'answer-message', '2026-10-03T00:00:00Z')`
        expect((yield* work.continuationContext("answer-run"))?.state?.record).toMatchObject(record)
        yield* sql`UPDATE space_tasks SET generation = generation + 1 WHERE item_id = ${saved.item_id}`
        expect(yield* work.continuationContext("answer-run")).toBeUndefined()
        const fenced = yield* work
          .update(
            { kind: "item", itemId: saved.item_id },
            saved.updated_at,
            { continuation_context: { next: ["old worker overwrite"] } },
            "answer-run"
          )
          .pipe(Effect.flip)
        expect(fenced.reason).toBe("conflict")
        expect((yield* work.taskContext(saved.item_id))?.state?.record).toMatchObject(record)
        yield* sql`UPDATE space_tasks SET generation = generation - 1 WHERE item_id = ${saved.item_id}`
        yield* inUnitOfWork(
          makeSpaceJobSql(sql, yield* SessionLifecycleEvents).materializeDue(at(MINUTE))
        )
        expect(
          yield* sql`SELECT next_attempt_at FROM space_tasks WHERE item_id = ${saved.item_id}`
        ).toEqual([{ next_attempt_at: null }])
        const queued = yield* sql<{
          readonly context: string
        }>`SELECT context FROM automation_event_queue WHERE task_id = ${taskJobId(saved.item_id)}`
        expect(queued.length).toBe(1)
        expect(queued[0]?.context).toContain(`"scheduled_for":"${at(0)}"`)
        const current = (yield* work.page({ itemId: saved.item_id })).items[0]
        if (current === undefined) throw new Error("Task missing")
        yield* work.update({ kind: "item", itemId: current.item_id }, current.updated_at, {
          continuation_context: null
        })
        const cleared = yield* readSpaceJobContext(sql, taskJobId(saved.item_id))
        if (cleared?.kind !== "task_execution") throw new Error("Task snapshot missing")
        expect(cleared.task?.state).toBeUndefined()
      }).pipe(Effect.provide(storage()))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("a wait on something external ends when its booked check comes due; a wait for the user stays", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-task-wait-"))
  const filename = join(directory, "arden.db")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const spaces = yield* SpaceStore
        const work = yield* WorkStore
        const sql = yield* SqlClient.SqlClient
        const space = yield* spaces.create({ name: "Lab" })
        const scope = { kind: "space", spaceId: space.space_id } as const
        const waitOn = (key: string, waitingOn: "you" | "external") =>
          Effect.gen(function* () {
            const task = yield* work.create(scope, { key, text: key })
            return yield* work.update({ kind: "key", scope, key }, task.updated_at, {
              blocked: true,
              waiting_on: waitingOn,
              block_reason: "Wait for the GPU quota to reset",
              next_attempt_at: at(0)
            })
          })
        const external = yield* waitOn("external-wait", "external")
        const yours = yield* waitOn("your-wait", "you")
        yield* sql`DELETE FROM automation_event_queue`
        yield* inUnitOfWork(
          makeSpaceJobSql(sql, yield* SessionLifecycleEvents).materializeDue(at(MINUTE))
        )
        expect(
          yield* sql`SELECT stable_key, blocked, waiting_on FROM space_tasks
            WHERE item_id IN (${external.item_id}, ${yours.item_id}) ORDER BY stable_key`
        ).toEqual([
          { stable_key: "external-wait", blocked: 0, waiting_on: null },
          { stable_key: "your-wait", blocked: 1, waiting_on: "you" }
        ])
        expect(
          yield* sql`SELECT item_id FROM space_task_events WHERE event_type = 'unblocked'`
        ).toEqual([{ item_id: external.item_id }])
      }).pipe(
        Effect.provide(
          Layer.merge(
            recoveredSqlitePersistenceLayer({ dataDir: null, filename }).pipe(
              Layer.provide(PersistenceWriteQueue.layer)
            ),
            SqliteClient.layer({ filename })
          )
        )
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
