import { readdirSync, readFileSync } from "node:fs"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { wikiChangedEvent } from "../src/automations/producers/wiki.js"
import { automationWikiChangeSinkLayer } from "../src/automations/wiki-change-sink.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { spaceJobId } from "../src/persistence/space-job-id.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { WikiChangeSink } from "../src/wiki/publication.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// Which change wakes a Space review: a Memory save and a page binding never; Space settings and
// a Task change made by hand do.

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

const message = (id: string, isMeta: boolean) => ({
  message_id: id,
  client_id: id,
  role: "user" as const,
  content: "Made-up words",
  created_at: new Date().toISOString(),
  ...(isMeta ? { is_meta: true } : {})
})

/** Starts a chat run through admission, as the app or the runtime does. */
const startChat = (
  sessionId: string,
  id: string,
  options: {
    readonly isMeta?: boolean
    readonly continuesTask?: string
    readonly automation?: {
      readonly automationId: string
      readonly attemptId: number
      readonly lease: { readonly id: number; readonly token: string }
    }
  } = {}
) =>
  Effect.gen(function* () {
    const chat = yield* ChatWriteStore
    const started = yield* chat.start({
      sessionId,
      clientId: id,
      requestHash: `${id}-hash`,
      assistantMessageId: `${id}-answer`,
      message: {
        ...message(id, options.isMeta ?? false),
        ...(options.automation === undefined
          ? {}
          : {
              content: "Made-up prompt",
              automation: {
                task_id: options.automation.automationId,
                name: "Made-up job",
                prompt: "Made-up prompt",
                context_mode: "fresh" as const
              }
            })
      },
      ...(options.continuesTask === undefined
        ? {}
        : { continuesTask: { itemId: options.continuesTask } }),
      ...(options.automation === undefined
        ? {}
        : {
            automation: {
              automationId: AutomationId.make(options.automation.automationId),
              attemptId: options.automation.attemptId,
              name: "Made-up job"
            },
            automationLease: options.automation.lease,
            automationPrompt: "Made-up prompt",
            automationContextMode: "fresh" as const
          })
    })
    return started.runId
  })

/** Claims every waiting job wake, then starts the named jobs' runs, as the runtime does. */
const startJobs = (ids: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const queue = yield* AutomationQueue
    const leases = yield* Effect.promise(async () =>
      queue.jobs.claim({
        workerId: "wakes",
        now: Date.now() + 60 * 60_000,
        limit: 10,
        leaseDurationMs: 60_000
      })
    )
    const runs = new Map<string, string>()
    for (const [automationId, id] of Object.entries(ids)) {
      const lease = leases.find((entry) => entry.payload.automationId === automationId)
      if (lease === undefined) throw new Error(`${automationId} was not claimed`)
      const [job] = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM scheduled_tasks WHERE task_id = ${automationId}`
      if (job === undefined) throw new Error(`${automationId} has no chat`)
      runs.set(
        automationId,
        yield* startChat(job.thread_id, id, {
          automation: {
            automationId,
            attemptId: lease.payload.automationRunId,
            lease: { id: lease.id, token: lease.token }
          }
        })
      )
    }
    return runs
  })

const updatedAt = (sql: SqlClient.SqlClient, itemId: string) =>
  sql<{
    readonly updated_at: string
  }>`SELECT updated_at FROM space_tasks WHERE item_id = ${itemId}`.pipe(
    Effect.map((rows) => rows[0]?.updated_at ?? AT)
  )

it("only a Task change made by hand wakes the Space review; no run's change does", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      const sessions = yield* SessionStore
      const work = yield* WorkStore
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      const chat = () =>
        sessions
          .create({ name: "Made-up chat", spaceId: "space-1" })
          .pipe(Effect.map((created) => created.sessionId))
      const taskChat = yield* chat()
      const inChat = yield* work.createInChat(taskChat, { request: "In chat" })
      const background = yield* work.create(
        { kind: "space", spaceId: "space-1" },
        { key: "background", text: "In the background" }
      )
      const jobs = yield* startJobs({
        [spaceJobId("space-1")]: "review",
        [`task:${background.item_id}`]: "worker"
      })
      const reviewRun = jobs.get(spaceJobId("space-1"))
      const workerRun = jobs.get(`task:${background.item_id}`)
      const ownerRun = yield* startChat(yield* chat(), "owner-turn")
      const stepRun = yield* startChat(taskChat, "task-step", {
        isMeta: true,
        continuesTask: inChat.item_id
      })
      const resultRun = yield* startChat(yield* chat(), "result", { isMeta: true })
      yield* clearQueue(sql)
      const edit = (itemId: string, text: string, runId?: string, actor?: "user") =>
        Effect.gen(function* () {
          yield* work.update(
            { kind: "item", itemId },
            yield* updatedAt(sql, itemId),
            { text },
            runId,
            runId === undefined ? undefined : `${runId}-call`,
            actor
          )
          return yield* reviewRows(sql, "space-1")
        })
      const byRuns = {
        review: yield* edit(background.item_id, "By the review", reviewRun),
        worker: yield* edit(background.item_id, "By the worker", workerRun),
        ownerTurn: yield* edit(background.item_id, "By the owner's turn", ownerRun),
        // A run acting for the user, as a token budget card the owner approved does.
        actingForUser: yield* edit(background.item_id, "For the user", ownerRun, "user"),
        taskStep: yield* edit(inChat.item_id, "By the Task step", stepRun),
        result: yield* edit(background.item_id, "By a result delivered", resultRun)
      }
      const byHand = yield* edit(background.item_id, "By the owner's hand")
      return { byRuns, byHand }
    })
  )
  expect(outcome.byRuns).toEqual({
    review: [],
    worker: [],
    ownerTurn: [],
    actingForUser: [],
    taskStep: [],
    result: []
  })
  expect(outcome.byHand).toEqual([{ causes: ["space.wake"], batched: true }])
})

it("the owner's own Task changes fold into one batched wake; a field the check does not compare wakes nothing", async () => {
  const rows = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const work = yield* WorkStore
      yield* space(sql, "space-1", true)
      yield* (yield* SpaceStore).bindPage("space-1", "page-1", "projects/made-up-space.md")
      yield* clearQueue(sql)
      const task = yield* work.create(
        { kind: "space", spaceId: "space-1" },
        { key: "a", text: "A" }
      )
      const address = { kind: "item", itemId: task.item_id } as const
      const created = yield* reviewRows(sql, "space-1")
      yield* clearQueue(sql)
      yield* work.createAttachment(address, {
        name: "made-up.txt",
        media_type: "text/plain",
        data: new TextEncoder().encode("made-up")
      })
      yield* work.update(address, yield* updatedAt(sql, task.item_id), { token_budget: 5000 })
      const uncompared = yield* reviewRows(sql, "space-1")
      yield* work.update(address, yield* updatedAt(sql, task.item_id), { text: "Edited" })
      yield* work.stop(address, yield* updatedAt(sql, task.item_id))
      return { created, uncompared, edited: yield* reviewRows(sql, "space-1") }
    })
  )
  expect(rows).toEqual({
    created: [{ causes: ["space.wake"], batched: true }],
    uncompared: [],
    edited: [{ causes: ["space.wake", "space.wake"], batched: true }]
  })
})

it("a Task change made by hand touches no other Task's worker job", async () => {
  const enabled = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const work = yield* WorkStore
      yield* space(sql, "space-1", true)
      yield* (yield* SpaceStore).bindPage("space-1", "page-1", "projects/made-up-space.md")
      const held = yield* work.create(
        { kind: "space", spaceId: "space-1" },
        { key: "a", text: "A" }
      )
      const edited = yield* work.create(
        { kind: "space", spaceId: "space-1" },
        { key: "b", text: "B" }
      )
      yield* sql`UPDATE scheduled_tasks SET enabled = 0 WHERE owner_task_id = ${held.item_id}`
      yield* work.update(
        { kind: "item", itemId: edited.item_id },
        yield* updatedAt(sql, edited.item_id),
        { text: "Edited" }
      )
      const [job] = yield* sql<{ readonly enabled: number }>`
        SELECT enabled FROM scheduled_tasks WHERE owner_task_id = ${held.item_id}`
      return job?.enabled
    })
  )
  expect(enabled).toBe(0)
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

it("binding a page readies the Space review but wakes nothing, first time or again", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* space(sql, "space-1", true)
      yield* spaces.bindPage("space-1", "page-1", "projects/made-up-space.md")
      const first = yield* reviewRows(sql, "space-1")
      yield* spaces.bindPage("space-1", "page-2", "projects/another-made-up-space.md")
      const [job] = yield* sql<{ readonly enabled: number }>`
        SELECT enabled FROM scheduled_tasks WHERE task_id = ${spaceJobId("space-1")}`
      return { first, again: yield* reviewRows(sql, "space-1"), enabled: job?.enabled }
    })
  )
  expect(outcome).toEqual({ first: [], again: [], enabled: 1 })
})
