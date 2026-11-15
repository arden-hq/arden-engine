import { readdirSync, readFileSync } from "node:fs"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { wikiChangedEvent } from "../src/automations/producers/wiki.js"
import { automationWikiChangeSinkLayer } from "../src/automations/wiki-change-sink.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { spaceJobId } from "../src/persistence/space-job-id.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { scheduledRunOrigin } from "../src/persistence/sqlite/run-context.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { WikiChangeSink } from "../src/wiki/publication.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// Which change wakes a Space review, from the source of each change. Memory pages alone start
// nothing, so a Memory save queues nothing; a Task change, Space settings and page binding wake.

const REVISION = "a".repeat(64)
const AT = "2026-11-01T00:00:00.000Z"

const space = (sql: SqlClient.SqlClient, spaceId: string, inference: boolean) =>
  sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
    VALUES (${spaceId}, ${`Made-up ${spaceId}`}, ${`made-up ${spaceId}`},
      ${JSON.stringify({ enabled: inference })}, ${AT}, ${AT})`

/** The queued review rows of one Space, each with the kinds of change that caused it. */
const reviewRows = (sql: SqlClient.SqlClient, spaceId: string) =>
  sql<{ readonly context: string; readonly next_attempt_at: string | null }>`
    SELECT context, next_attempt_at FROM automation_event_queue
    WHERE task_id = ${spaceJobId(spaceId)} ORDER BY id`.pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const snapshot = JSON.parse(row.context).trigger_context_snapshot
        const causes: ReadonlyArray<{ source: string; event_type?: string }> =
          snapshot.source === "coalesced" ? snapshot.causes : [snapshot]
        return {
          causes: causes.map((cause) => cause.event_type ?? cause.source),
          batched: row.next_attempt_at !== null
        }
      })
    )
  )

const clearQueue = (sql: SqlClient.SqlClient) => sql`DELETE FROM automation_event_queue`

it("a Memory save queues no Space review, through the wiki change path or a dispatch", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      const triggers = yield* AutomationTriggers
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      // A review job stored before Memory stopped waking reviews still subscribes to it.
      yield* sql`UPDATE scheduled_tasks
        SET triggers = '[{"type":"event","event_type":"wiki.changed","id":"t1"}]', trigger_last_id = 1
        WHERE purpose = 'space_review'`
      yield* spaces.update("space-1", { name: "Made-up Space again" })
      const jobs = yield* sql<{ readonly triggers: string }>`
        SELECT triggers FROM scheduled_tasks WHERE purpose = 'space_review'`
      yield* clearQueue(sql)
      const published = yield* Effect.gen(function* () {
        const sink = yield* WikiChangeSink
        yield* sink.cursor(null)
        return yield* sink.publish({
          previousRevision: null,
          revision: REVISION,
          savedAt: AT,
          paths: ["projects/made-up-space.md"],
          origin: { kind: "user", via: "desktop" },
          hasSpacePage: true
        })
      }).pipe(Effect.provide(automationWikiChangeSinkLayer))
      const dispatched = yield* triggers.dispatchEvent(
        wikiChangedEvent({
          paths: ["projects/made-up-space.md"],
          revision: "b".repeat(64),
          savedAt: AT,
          source: "user",
          hasSpacePage: true,
          producedBy: null,
          chainDepth: 0
        })
      )
      return {
        jobs: jobs.map((job) => job.triggers),
        published,
        dispatched,
        rows: yield* reviewRows(sql, "space-1")
      }
    })
  )
  expect(outcome.jobs).toEqual(["[]"])
  expect(outcome.published).toEqual({ queued: 0 })
  expect(outcome.dispatched).toEqual({ queued: 0 })
  expect(outcome.rows).toEqual([])
})

it("nothing on the wiki change path or in event dispatch can reach a Space review", () => {
  const src = new URL("../src/", import.meta.url)
  const read = (file: string) => readFileSync(new URL(file, src), "utf8")
  const wikiPath = [
    "automations/wiki-change-sink.ts",
    "automations/producers/wiki.ts",
    ...readdirSync(new URL("wiki/", src)).map((file) => `wiki/${file}`)
  ]
  for (const file of wikiPath.filter((name) => name.endsWith(".ts")))
    expect(read(file), file).not.toMatch(/space-jobs|queueSpaceWake|spaceJobId|space_review/)
  expect(read("persistence/sqlite/automation-event-dispatch.ts")).not.toMatch(/space_review/)
})

/** A run that is now writing: a Space review, or the worker of one Task, woken at a depth. */
const seedRun = (
  sql: SqlClient.SqlClient,
  run: {
    readonly id: string
    readonly automationId: string | null
    readonly actor?: "person"
    readonly origin: object
    readonly task: string | null
    readonly depth: number
  }
) =>
  sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, metadata_json,
      assistant_message_id, authority_json)
    VALUES (${run.id}, 'session-1', 'running', ${AT}, ${AT},
      ${JSON.stringify({
        run_policy: {
          budget_id: "budget-1",
          execution: { mode: "inline", observe: false },
          capabilities: ["all"],
          auto_approve: false,
          google_accounts: null,
          space: null
        },
        run_context: {
          origin: { ...run.origin, ...(run.depth === 0 ? {} : { chain_depth: run.depth }) },
          task: run.task === null ? null : { item_id: run.task, generation: 0 }
        }
      })},
      ${`assistant-${run.id}`},
      ${JSON.stringify({
        ...(run.actor === undefined ? {} : { actor: { kind: run.actor } }),
        owns: { automation_id: run.automationId, chain_depth: run.depth }
      })})`

const seedSpaceWithTask = (sql: SqlClient.SqlClient, spaces: SpaceStore["Service"]) =>
  Effect.gen(function* () {
    yield* space(sql, "space-1", true)
    yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
    yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type,
        space_id)
      VALUES ('session-1', 'chat~1', ${AT}, ${AT}, 'chat', 'space-1')`
    yield* sql`INSERT INTO execution_budgets (budget_id) VALUES ('budget-1')`
    yield* sql`INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner, runs_in,
        home_session_id, created_at, updated_at)
      VALUES ('task-1', 'space-1', 'key-1', 'Made-up Task', 'open', 'worker', 'chat', 'session-1',
        ${AT}, ${AT})`
    yield* clearQueue(sql)
  })

const updatedAt = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly updated_at: string
  }>`SELECT updated_at FROM space_tasks WHERE item_id = 'task-1'`.pipe(
    Effect.map((rows) => rows[0]?.updated_at ?? AT)
  )

/** The Task worker's waiting wake: who caused it, at what depth, and whether it is the owner's. */
const workerWake = (sql: SqlClient.SqlClient) =>
  sql<{ readonly context: string }>`SELECT context FROM automation_event_queue
    WHERE task_id = 'task:task-1'`.pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const context = JSON.parse(row.context)
        const snapshot = context.trigger_context_snapshot
        return {
          producedBy: snapshot.produced_by ?? null,
          depth: snapshot.chain_depth ?? 0,
          owner: context.person_change_at !== undefined
        }
      })
    )
  )

/** Feeds the trigger listener every Task history record the journal holds, as the runtime does. */
const feedTaskHistory = (sql: SqlClient.SqlClient, triggers: AutomationTriggers["Service"]) =>
  Effect.gen(function* () {
    const records = yield* sql<{ readonly sequence: number; readonly data_json: string }>`
      SELECT sequence, data_json FROM journal_records WHERE event_type = 'task_history_added'
      ORDER BY sequence`
    for (const record of records)
      yield* triggers.applyTriggerFeedRecord({
        sequence: record.sequence,
        atMs: Date.parse(AT),
        kind: "other",
        sessionId: null,
        journal: { atMs: Date.parse(AT), event: JSON.parse(record.data_json) }
      })
  })

it("the owner's own Task changes wake the Space review once per burst; a run's changes wake none", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      const work = yield* WorkStore
      const triggers = yield* AutomationTriggers
      yield* seedSpaceWithTask(sql, spaces)
      yield* seedRun(sql, {
        id: "review-run",
        automationId: spaceJobId("space-1"),
        origin: { kind: "space", space_id: "space-1", occurrence_id: "wake-1" },
        task: null,
        depth: 0
      })
      yield* seedRun(sql, {
        id: "worker-run",
        automationId: "task:task-1",
        origin: { kind: "task", item_id: "task-1", occurrence_id: "wake-2" },
        task: "task-1",
        depth: 0
      })
      yield* seedRun(sql, {
        id: "owner-chat-run",
        automationId: null,
        actor: "person",
        origin: { kind: "chat", session_id: "session-1", turn_id: "turn-1" },
        task: null,
        depth: 0
      })
      const address = { kind: "item", itemId: "task-1" } as const
      yield* work.update(
        address,
        yield* updatedAt(sql),
        { text: "Edited by the review" },
        "review-run"
      )
      yield* work.update(
        address,
        yield* updatedAt(sql),
        { text: "Edited by the worker" },
        "worker-run"
      )
      yield* feedTaskHistory(sql, triggers)
      const runMade = yield* reviewRows(sql, "space-1")
      yield* work.update(address, yield* updatedAt(sql), { text: "Edited by the owner" })
      yield* work.update(
        address,
        yield* updatedAt(sql),
        { text: "Edited in the owner's chat" },
        "owner-chat-run"
      )
      yield* work.stop(address, yield* updatedAt(sql))
      yield* work.create({ kind: "space", spaceId: "space-1" }, { key: "key-2", text: "Another" })
      yield* feedTaskHistory(sql, triggers)
      return { runMade, owner: yield* reviewRows(sql, "space-1") }
    })
  )
  expect(outcome.runMade).toEqual([])
  expect(outcome.owner).toEqual([
    { causes: ["task.changed", "task.changed", "task.changed", "task.changed"], batched: true }
  ])
})

it("a run's wake for a Task worker carries the run's cause and depth, and stops at the chain limit", async () => {
  const wakeFrom = (depth: number) =>
    withTempDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const work = yield* WorkStore
        yield* seedSpaceWithTask(sql, yield* SpaceStore)
        yield* seedRun(sql, {
          id: "review-run",
          automationId: spaceJobId("space-1"),
          origin: { kind: "space", space_id: "space-1", occurrence_id: "wake-1" },
          task: null,
          depth
        })
        // The review moves a Task working in its chat to the background, which wakes its worker.
        yield* work.update(
          { kind: "item", itemId: "task-1" },
          yield* updatedAt(sql),
          { runs_in: "background" },
          "review-run"
        )
        return yield* workerWake(sql)
      })
    )
  expect(await wakeFrom(0)).toEqual([{ producedBy: spaceJobId("space-1"), depth: 1, owner: false }])
  expect(await wakeFrom(1)).toEqual([])
})

it("the depth a run was woken at stays with a review or Task run, so its writes know it", () => {
  for (const purpose of ["space_review", "task_execution"] as const) {
    const origin = scheduledRunOrigin({
      job: { purpose, owner_space_id: "space-1", owner_task_id: "task-1", handler: null },
      automationId: purpose === "space_review" ? spaceJobId("space-1") : "task:task-1",
      occurrenceId: "queue:1",
      chainDepth: 1
    })
    expect(origin).toMatchObject({ chain_depth: 1 })
  }
})

it("drafted instructions that say the same thing wake nothing", async () => {
  const rows = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      yield* spaces.setGeneratedInstructions("space-1", "Made-up drafted instructions.")
      yield* clearQueue(sql)
      yield* spaces.setGeneratedInstructions("space-1", "Made-up drafted instructions.")
      return yield* reviewRows(sql, "space-1")
    })
  )
  expect(rows).toEqual([])
})

it("a Space bound to a Memory page cannot be bound to another without detaching first", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      yield* clearQueue(sql)
      const refused = yield* spaces
        .bindPage("space-1", "page-2", "projects/another-made-up-space.md")
        .pipe(Effect.flip)
      return { reason: refused.reason, rows: yield* reviewRows(sql, "space-1") }
    })
  )
  expect(outcome).toEqual({ reason: "conflict", rows: [] })
})

it("Space settings wake the review the same way whether the owner or Arden wrote them", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      yield* space(sql, "space-2", true)
      yield* clearQueue(sql)
      yield* spaces.setGeneratedInstructions("space-1", "Made-up drafted instructions.")
      const drafted = yield* reviewRows(sql, "space-1")
      yield* clearQueue(sql)
      yield* spaces.update("space-1", { instructions: "Made-up owner instructions." })
      const written = yield* reviewRows(sql, "space-1")
      yield* spaces.setGeneratedInstructions("space-2", "Made-up drafted instructions.")
      return { drafted, written, noPage: yield* reviewRows(sql, "space-2") }
    })
  )
  expect(outcome.drafted).toEqual([{ causes: ["space.wake"], batched: true }])
  expect(outcome.written).toEqual(outcome.drafted)
  expect(outcome.noPage).toEqual([])
})

it("binding the Space to another Memory page wakes the review", async () => {
  const rows = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      yield* spaces.detachPage("space-1")
      yield* clearQueue(sql)
      yield* spaces.bindPage("space-1", "page-2", "projects/another-made-up-space.md")
      return yield* reviewRows(sql, "space-1")
    })
  )
  expect(rows).toEqual([{ causes: ["space.wake"], batched: true }])
})
