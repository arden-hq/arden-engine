import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import {
  claimAll,
  endJobWithoutRun,
  finishChat,
  runJob,
  startChat,
  type JobLease
} from "./fixtures/job-runs.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { automationWikiChangeSinkLayer } from "../src/automations/wiki-change-sink.js"
import { WikiChangeSink } from "../src/wiki/publication.js"

const AT = "2026-11-01T00:00:00.000Z"
const ROUNDS = 6

const updatedAt = (sql: SqlClient.SqlClient, itemId: string) =>
  sql<{ readonly updated_at: string }>`
    SELECT updated_at FROM space_tasks WHERE item_id = ${itemId}`.pipe(
    Effect.map((rows) => rows[0]?.updated_at ?? AT)
  )

const journalHead = (sql: SqlClient.SqlClient) =>
  sql<{ readonly head: number | null }>`SELECT MAX(sequence) AS head FROM journal_records`.pipe(
    Effect.map((rows) => rows[0]?.head ?? 0)
  )

/** Sends every Task change journaled since `after` to the Automation triggers, as the feed does. */
const dispatchTaskChanges = (after: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const triggers = yield* AutomationTriggers
    const rows = yield* sql<{ readonly data_json: string }>`
      SELECT data_json FROM journal_records
      WHERE event_type = 'task_history_added' AND sequence > ${after} ORDER BY sequence`
    for (const row of rows) {
      const added = JSON.parse(row.data_json) as {
        readonly event_id: number
        readonly item_id: string
        readonly produced_by: string | null
        readonly chain_depth: number
      }
      yield* triggers.dispatchEvent({
        eventType: "task.changed",
        eventKey: String(added.event_id),
        producedBy: added.produced_by,
        chainDepth: added.chain_depth,
        context: { task: { change: "changed", item_id: added.item_id } }
      })
    }
    return yield* journalHead(sql)
  })

/**
 * A made-up Space with an owner Automation that edits a Task whenever a Task changes, and one
 * Task made by `makeTask`. Nothing waits when it returns: the Task's first wake is dropped, so the
 * owner's edit by hand is the only start.
 */
const followerAndTask = <R>(makeTask: Effect.Effect<{ readonly item_id: string }, unknown, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
      VALUES ('space-1', 'Made-up Space', 'made-up space', '{"enabled":false}', ${AT}, ${AT})`
    const follower = yield* (yield* AutomationCatalog).create(
      {
        name: "Made-up follower",
        prompt: "Edit the Task that changed",
        history: "fresh",
        triggers: [{ type: "event", event_type: "task.changed" }],
        idempotency_key: "3c1d6f0a-2b4e-4c8d-9a7f-5e6b1c2d3a4f",
        idempotency_scope: "global"
      },
      "owner"
    )
    const task = yield* makeTask
    yield* sql`DELETE FROM automation_event_queue`
    const work = yield* WorkStore
    const edit = (runId: string | undefined, text: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* work.update(
          { kind: "item", itemId: task.item_id },
          yield* updatedAt(sql, task.item_id),
          { text },
          runId,
          runId === undefined ? undefined : `${runId}-call`
        )
      }).pipe(Effect.orDie)
    return {
      follower: follower.task_id,
      itemId: task.item_id,
      worker: `task:${task.item_id}`,
      edit,
      seen: yield* journalHead(sql)
    }
  })

/** Each round the Task changes go out, then every claimed wake runs once: the follower's edits
 *  the Task, and `worker` runs the Task's worker. */
const rounds = <R>(
  setup: Effect.Success<ReturnType<typeof followerAndTask>>,
  worker: (lease: JobLease, round: number) => Effect.Effect<void, unknown, R>
) =>
  Effect.gen(function* () {
    let seen = setup.seen
    const ran: Array<ReadonlyArray<string>> = []
    for (let round = 1; round <= ROUNDS; round += 1) {
      seen = yield* dispatchTaskChanges(seen)
      const leases = yield* claimAll(`round-${round}`)
      const follower = leases.find((lease) => lease.payload.automationId === setup.follower)
      const task = leases.find((lease) => lease.payload.automationId === setup.worker)
      if (follower !== undefined)
        yield* runJob(follower, `follower-${round}`, (runId) =>
          setup.edit(runId, `Edited by the follower ${round}`)
        )
      if (task !== undefined) yield* worker(task, round)
      ran.push([...(follower ? ["follower"] : []), ...(task ? ["worker"] : [])])
    }
    return ran
  })

const followerRuns = (ran: ReadonlyArray<ReadonlyArray<string>>) =>
  ran.map((round) => round.filter((job) => job === "follower").length)

// The owner's edit wakes the follower and the worker; the worker's change wakes the follower once
// more. The follower's own edits wake the worker one step deeper each time, so the chain ends.
it("an owner Automation on task.changed that edits a Task stops at the chain limit, not in a loop through the Task's worker", async () => {
  const ran = await withTempDatabase(
    Effect.gen(function* () {
      const setup = yield* followerAndTask(
        (yield* WorkStore).create(
          { kind: "space", spaceId: "space-1" },
          { key: "made-up", text: "Made-up Task" }
        )
      )
      yield* setup.edit(undefined, "Edited by hand")
      return yield* rounds(setup, (lease, round) =>
        runJob(lease, `worker-${round}`, (runId) =>
          setup.edit(runId, `Edited by the worker ${round}`)
        )
      )
    })
  )
  expect(ran[0]).toEqual(["follower", "worker"])
  expect(followerRuns(ran)).toEqual([1, 1, 0, 0, 0, 0])
})

// An in-chat step is not an Automation run, so it adds no depth; it passes on the depth it was
// woken at, and the follower's runs add theirs, so this chain ends too.
it("an owner Automation on task.changed that edits an in-chat Task stops at the chain limit", async () => {
  const ran = await withTempDatabase(
    Effect.gen(function* () {
      let taskChat = ""
      const setup = yield* followerAndTask(
        Effect.gen(function* () {
          taskChat = (yield* (yield* SessionStore).create({
            name: "Made-up chat",
            spaceId: "space-1"
          })).sessionId
          return yield* (yield* WorkStore).createInChat(taskChat, {
            request: "Made-up in-chat Task"
          })
        })
      )
      yield* setup.edit(undefined, "Edited by hand")
      return yield* rounds(setup, (lease, round) =>
        Effect.gen(function* () {
          yield* endJobWithoutRun(lease)
          const started = yield* startChat(taskChat, `step-${round}`, {
            isMeta: true,
            continuesTask: { itemId: setup.itemId, chainDepth: lease.payload.chainDepth }
          })
          yield* setup.edit(started.runId, `Edited by step ${round}`)
          yield* finishChat(started, `step-${round}`)
        })
      )
    })
  )
  expect(followerRuns(ran)).toEqual([1, 1, 1, 1, 0, 0])
})

it("a Memory write by an in-chat step carries the depth it was woken at to the change it announces", async () => {
  const queued = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const listener = yield* (yield* AutomationCatalog).create(
        {
          name: "Made-up listener",
          prompt: "Read the Memory change",
          history: "fresh",
          triggers: [{ type: "event", event_type: "wiki.changed" }],
          idempotency_key: "5b8c0d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f",
          idempotency_scope: "global"
        },
        "owner"
      )
      const sink = yield* WikiChangeSink
      yield* sink.cursor(null)
      const publish = (revision: string, chainDepth: number) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM automation_event_queue`
          yield* sink.publish({
            previousRevision: null,
            revision,
            savedAt: AT,
            paths: ["notes/made-up.md"],
            origin: { kind: "agent", sessionId: "chat-1", chainDepth },
            hasSpacePage: false
          })
          const rows = yield* sql<{ readonly task_id: string }>`
            SELECT task_id FROM automation_event_queue WHERE task_id = ${listener.task_id}`
          return rows.length
        })
      return {
        atOne: yield* publish("a".repeat(64), 1),
        atTwo: yield* publish("b".repeat(64), 2)
      }
    }).pipe(Effect.provide(automationWikiChangeSinkLayer))
  )
  expect(queued).toEqual({ atOne: 1, atTwo: 0 })
})
