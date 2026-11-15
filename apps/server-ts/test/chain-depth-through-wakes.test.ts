import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { spaceJobId } from "../src/persistence/space-job-id.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import {
  claimAll,
  endJobWithoutRun,
  failJob,
  finishChat,
  runJob,
  startChat,
  startJobs,
  type JobLease
} from "./fixtures/job-runs.js"
import { freePage } from "./fixtures/free-space-page.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { automationWikiChangeSinkLayer } from "../src/automations/wiki-change-sink.js"
import { WikiChangeSink } from "../src/wiki/publication.js"
import { wikiMaintenanceHandler } from "../src/automations/handlers/wiki-maintenance.js"

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
const followerAndTask = <T extends { readonly item_id: string }, R>(
  makeTask: Effect.Effect<T, unknown, R>
) =>
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
      task,
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
  worker: (lease: JobLease, round: number) => Effect.Effect<void, unknown, R>,
  count = ROUNDS
) =>
  Effect.gen(function* () {
    let seen = setup.seen
    const ran: Array<ReadonlyArray<string>> = []
    for (let round = 1; round <= count; round += 1) {
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

/** A made-up chat in the Space, and a Task that runs in it. */
const inChatTask = Effect.gen(function* () {
  const chat = yield* (yield* SessionStore).create({ name: "Made-up chat", spaceId: "space-1" })
  const task = yield* (yield* WorkStore).createInChat(chat.sessionId, {
    request: "Made-up in-chat Task"
  })
  return { ...task, sessionId: chat.sessionId }
})

/** The next step of an in-chat Task, as `continueTask` finds it. */
const nextStep = (itemId: string) =>
  Effect.gen(function* () {
    const step = yield* (yield* WorkStore).nextInChat({ itemId })
    if (step === undefined) throw new Error("the in-chat Task has no step to take")
    return step
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
      const setup = yield* followerAndTask(inChatTask)
      yield* setup.edit(undefined, "Edited by hand")
      return yield* rounds(setup, (lease, round) =>
        Effect.gen(function* () {
          yield* endJobWithoutRun(lease)
          yield* nextStep(setup.itemId)
          const started = yield* startChat(setup.task.sessionId, `step-${round}`, {
            isMeta: true,
            continuesTask: { itemId: setup.itemId }
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
      const publish = (previousRevision: string | null, revision: string, chainDepth: number) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM automation_event_queue`
          yield* sink.publish({
            previousRevision,
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
        atOne: yield* publish(null, "a".repeat(64), 1),
        atTwo: yield* publish("a".repeat(64), "b".repeat(64), 2)
      }
    }).pipe(Effect.provide(automationWikiChangeSinkLayer))
  )
  expect(queued).toEqual({ atOne: 1, atTwo: 0 })
})

// Tidy keeps a place in Memory history and reads every change from it; it never wakes itself, and
// each of its changes is one step deeper, so the owner's Automations still stop at the limit.
it("Tidy is woken by a Memory change at any depth; an owner Automation on wiki.changed stops at the limit", async () => {
  const queued = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      yield* catalog.seedSystemAutomations([wikiMaintenanceHandler.spec])
      const listener = yield* catalog.create(
        {
          name: "Made-up listener",
          prompt: "Read the Memory change",
          history: "fresh",
          triggers: [{ type: "event", event_type: "wiki.changed" }],
          idempotency_key: "7d9e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a",
          idempotency_scope: "global"
        },
        "owner"
      )
      const sink = yield* WikiChangeSink
      yield* sink.cursor(null)
      const woken = (previousRevision: string | null, revision: string, wakeDepth: number) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM automation_event_queue`
          yield* sink.publish({
            previousRevision,
            revision,
            savedAt: AT,
            paths: ["notes/made-up.md"],
            origin: { kind: "automation", automationId: "made-up-other", chainDepth: wakeDepth },
            hasSpacePage: false
          })
          const rows = yield* sql<{ readonly task_id: string }>`
            SELECT task_id FROM automation_event_queue ORDER BY task_id`
          const named = new Map([
            [listener.task_id, "listener"],
            [wikiMaintenanceHandler.spec.automationId, "tidy"]
          ])
          return rows.map((row) => named.get(row.task_id) ?? row.task_id).sort()
        })
      return {
        atOne: yield* woken(null, "a".repeat(64), 0),
        atThree: yield* woken("a".repeat(64), "b".repeat(64), 2)
      }
    }).pipe(Effect.provide(automationWikiChangeSinkLayer))
  )
  expect(queued).toEqual({
    atOne: ["listener", "tidy"],
    atThree: ["tidy"]
  })
})

it("a failed Space review is retried at the depth of the wake it answered", async () => {
  const retried = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
        VALUES ('space-1', 'Made-up Space', 'made-up space', '{"enabled":true}', ${AT}, ${AT})`
      const spaces = yield* SpaceStore
      yield* spaces.bindPage("space-1", freePage("page-1", "projects/made-up-space.md"))
      const follower = yield* (yield* AutomationCatalog).create(
        {
          name: "Made-up follower",
          prompt: "Write the Space's instructions",
          history: "fresh",
          triggers: [{ type: "event", event_type: "task.changed" }],
          idempotency_key: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
          idempotency_scope: "global"
        },
        "owner"
      )
      yield* sql`DELETE FROM automation_event_queue`
      yield* (yield* AutomationTriggers).dispatchEvent({
        eventType: "task.changed",
        eventKey: "1",
        producedBy: null,
        chainDepth: 0,
        context: { task: { change: "changed", item_id: "made-up" } }
      })
      const runs = yield* startJobs({ [follower.task_id]: "follower" })
      yield* spaces.update(
        "space-1",
        { instructions: "Made-up instructions" },
        runs.get(follower.task_id)
      )
      const review = (yield* claimAll("review")).find(
        (lease) => lease.payload.automationId === spaceJobId("space-1")
      )
      if (review === undefined) throw new Error("the Space review was not woken")
      yield* failJob(review)
      const rows = yield* sql<{ readonly context: string }>`
        SELECT context FROM automation_event_queue WHERE task_id = ${spaceJobId("space-1")}`
      return rows.map((row) => {
        const wake = JSON.parse(row.context).trigger_context_snapshot
        return { event: wake.event_type, depth: wake.chain_depth ?? 0 }
      })
    })
  )
  expect(retried).toEqual([{ event: "space.review_retry", depth: 1 }])
})

// A wake and a restart both hand an in-chat Task on by its id only; admission reads the depth of
// the Task's latest wake, as a due check does, so no caller states a depth.
it("an in-chat Task step is admitted at the depth of the Task's latest wake", async () => {
  const depths = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const setup = yield* followerAndTask(inChatTask)
      const admitted = (id: string) =>
        Effect.gen(function* () {
          const started = yield* startChat(setup.task.sessionId, id, {
            isMeta: true,
            continuesTask: { itemId: setup.itemId }
          })
          yield* finishChat(started, id)
          const [row] = yield* sql<{ readonly depth: number | null }>`
            SELECT json_extract(metadata_json, '$.run_context.origin.chain_depth') AS depth
            FROM chat_runs WHERE run_id = ${started.runId}`
          return row?.depth ?? 0
        })
      const created = yield* admitted("step-created")
      yield* setup.edit(undefined, "Edited by hand")
      yield* rounds(setup, (lease) => endJobWithoutRun(lease), 2)
      return { created, woken: yield* admitted("step-woken") }
    })
  )
  expect(depths).toEqual({ created: 0, woken: 1 })
})

// The end of a run hands the step on at the depth that run's changes carry: an owner Automation's
// run adds one to the wake it answered, whatever the Task's own latest wake was.
it("an in-chat Task step handed on by a run's end is admitted at the depth of that run's changes", async () => {
  const depth = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const setup = yield* followerAndTask(inChatTask)
      yield* setup.edit(undefined, "Edited by hand")
      yield* dispatchTaskChanges(setup.seen)
      const follower = (yield* claimAll("round-1")).find(
        (lease) => lease.payload.automationId === setup.follower
      )
      if (follower === undefined) throw new Error("the follower was not woken")
      let followerRun = ""
      yield* runJob(follower, "follower-1", (runId) => Effect.sync(() => (followerRun = runId)))
      const started = yield* startChat(setup.task.sessionId, "step-after-run", {
        isMeta: true,
        continuesTask: { itemId: setup.itemId, afterRunId: followerRun }
      })
      const [row] = yield* sql<{ readonly depth: number | null }>`
        SELECT json_extract(metadata_json, '$.run_context.origin.chain_depth') AS depth
        FROM chat_runs WHERE run_id = ${started.runId}`
      return row?.depth ?? 0
    })
  )
  expect(depth).toBe(1)
})
