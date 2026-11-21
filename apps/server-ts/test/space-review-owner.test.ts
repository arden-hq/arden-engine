import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ApprovalPolicyStore } from "../src/persistence/permissions/approval-policy.js"
import { storedAuthority } from "../src/persistence/sqlite/run-authority.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { spaceJobId, taskJobId } from "../src/persistence/space-job-id.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { freePage } from "./fixtures/free-space-page.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { startJob } from "./fixtures/job-runs.js"
import { LATER, claim, makeAutomation, requestRun, type Lease } from "./work-fixtures.js"

const REVIEW = spaceJobId("space-1")

// SQLite has no "BEFORE INSERT OR UPDATE", so the guard is two triggers with the same condition.
const guardDefinitions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const event of ["INSERT", "UPDATE"])
    yield* sql.unsafe(`CREATE TRIGGER reject_synthetic_space_review_${event.toLowerCase()}
      BEFORE ${event} ON scheduled_tasks WHEN NEW.purpose = 'space_review'
      BEGIN SELECT RAISE(ABORT, 'reject_synthetic_space_review: a Space review definition row was written'); END`)
})

const makeSpace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
    VALUES ('space-1', 'Made-up', 'made-up', '{"enabled":true}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
  yield* (yield* SpaceStore).bindPage("space-1", freePage("page-1", "projects/made-up.md"))
  return yield* (yield* WorkStore).create(
    { kind: "space", spaceId: "space-1" },
    { key: "background", text: "In the background" }
  )
})

const editByHand = (itemId: string, text: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly updated_at: string }>`
      SELECT updated_at FROM space_tasks WHERE item_id = ${itemId}`
    yield* (yield* WorkStore).update({ kind: "item", itemId }, row?.updated_at ?? "", { text })
  })

const reviewWakes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM automation_event_queue WHERE task_id = ${REVIEW}`)[0]?.n
})

const storedRun = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly origin: string | null; readonly actor: string | null }>`
      SELECT json_extract(metadata_json, '$.run_context.origin') AS origin,
        json_extract(authority_json, '$.actor') AS actor
      FROM chat_runs WHERE run_id = ${runId}`
    return {
      origin: row?.origin == null ? null : JSON.parse(row.origin),
      actor: row?.actor == null ? null : JSON.parse(row.actor)
    }
  })

const finish = (
  lease: Lease,
  run: Effect.Success<ReturnType<typeof startJob>>,
  id: string,
  at: number
) =>
  Effect.gen(function* () {
    const chat = yield* ChatWriteStore
    const started = run.run
    yield* chat.finish({
      runId: started.runId,
      messages: [
        ...started.activeMessages,
        {
          message_id: `${id}-answer`,
          role: "assistant",
          content: "Made-up result",
          created_at: new Date().toISOString()
        }
      ]
    })
    const queue = yield* AutomationQueue
    yield* Effect.promise(async () =>
      queue.jobs.complete({
        ...lease,
        completedAt: at,
        result: {
          status: "ended",
          outcome: "finished",
          result: "Made-up result",
          error: null,
          chatRunId: started.runId,
          chatSessionId: run.sessionId
        }
      })
    )
  })

const reviewPrompt = (lease: Lease) =>
  lease.payload.prompt.kind === "space_job" && lease.payload.prompt.context.kind === "space_review"
    ? lease.payload.prompt.context.space
    : undefined

it("a Space review wakes, runs in its private chat and settles with no definition row", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* guardDefinitions
      const task = yield* makeSpace
      yield* editByHand(task.item_id, "Edited by hand")
      const queuedAfterEdit = yield* reviewWakes
      const authored = yield* makeAutomation
      yield* requestRun(authored)

      const first = yield* claim("first", 10)
      const review = first.find((lease) => lease.payload.automationId === REVIEW)
      const worker = first.find((lease) => lease.payload.automationId === taskJobId(task.item_id))
      const automation = first.find((lease) => lease.payload.automationId === authored)
      if (review === undefined || worker === undefined || automation === undefined)
        throw new Error(
          `Not every owner was claimed: ${first.map((l) => l.payload.automationId).join(", ")}`
        )
      const [hold] = yield* sql<{
        readonly hold_started_at: string | null
        readonly claimed_at: string
      }>`
        SELECT hold_started_at, claimed_at FROM automation_event_queue WHERE id = ${Number(review.id)}`
      const reviewRun = yield* startJob(review, "review-1")
      const workerRun = yield* startJob(worker, "worker-1")
      const automationRun = yield* startJob(automation, "automation-1")
      const [chat] = yield* sql<{
        readonly origin_automation_id: string | null
        readonly session_type: string
      }>`
        SELECT origin_automation_id, session_type FROM sessions WHERE session_id = ${review.payload.sessionId}`
      yield* finish(review, reviewRun, "review-1", LATER + 1_000)
      const [settled] = yield* sql<{
        readonly status: string
        readonly outcome: string
        readonly purpose: string
      }>`
        SELECT status, outcome, purpose FROM automation_runs WHERE id = ${review.payload.automationRunId}`

      yield* editByHand(task.item_id, "Edited by hand again")
      const second = yield* claim("second", 10, LATER + 2 * 60 * 60_000)
      const again = second.find((lease) => lease.payload.automationId === REVIEW)
      if (again === undefined) throw new Error("The second change did not wake the review")
      const againRun = yield* startJob(again, "review-2")
      yield* finish(again, againRun, "review-2", LATER + 2 * 60 * 60_000 + 1_000)

      return {
        queuedAfterEdit,
        review: {
          purpose: review.payload.purpose,
          name: review.payload.name,
          contextMode: review.payload.contextMode,
          chatKind: review.payload.chatKind,
          spaceId: reviewPrompt(review)?.spaceId,
          taskText: reviewPrompt(review)?.openTasks.map((item) => item.text)
        },
        heldFromClaim: hold?.hold_started_at === hold?.claimed_at,
        chat,
        stored: yield* storedRun(reviewRun.run.runId),
        settled,
        again: {
          attempt: again.payload.automationRunId !== review.payload.automationRunId,
          sameChat: again.payload.sessionId === review.payload.sessionId,
          taskText: reviewPrompt(again)?.openTasks.map((item) => item.text)
        },
        others: {
          worker: (yield* storedRun(workerRun.run.runId)).actor?.kind,
          automation: (yield* storedRun(automationRun.run.runId)).actor?.kind
        },
        queuedAtEnd: yield* reviewWakes,
        definitions: yield* sql<{ readonly task_id: string }>`
          SELECT task_id FROM scheduled_tasks WHERE purpose = 'space_review'`
      }
    })
  )
  expect(outcome).toEqual({
    queuedAfterEdit: 1,
    review: {
      purpose: "space_review",
      name: "Made-up worker",
      contextMode: "fresh",
      chatKind: "own",
      spaceId: "space-1",
      taskText: ["Edited by hand"]
    },
    heldFromClaim: true,
    chat: { origin_automation_id: REVIEW, session_type: "channel" },
    stored: {
      origin: expect.objectContaining({ kind: "space", space_id: "space-1" }),
      actor: { kind: "space_review", space_id: "space-1" }
    },
    settled: { status: "completed", outcome: "finished", purpose: "space_review" },
    again: { attempt: true, sameChat: true, taskText: ["Edited by hand again"] },
    others: { worker: "task_worker", automation: "automation" },
    queuedAtEnd: 0,
    definitions: []
  })
})

it("a review keeps its hold start through a reclaim, shows in the queue list, retries after a failure, and settles once its Space is gone", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const queue = yield* AutomationQueue
      yield* guardDefinitions
      yield* makeSpace
      const first = (yield* claim("first", 10)).find(
        (lease) => lease.payload.automationId === REVIEW
      )
      if (first === undefined) throw new Error("The review was not claimed")
      const holdOf = (id: string) =>
        sql<{ readonly hold_started_at: string | null; readonly claimed_at: string | null }>`
          SELECT hold_started_at, claimed_at FROM automation_event_queue WHERE id = ${Number(id)}`.pipe(
          Effect.map((rows) => rows[0])
        )
      const held = yield* holdOf(first.id)
      const listed = (yield* (yield* AutomationCatalog).diagnostics()).queue.find(
        (row) => row.task_id === REVIEW
      )
      const back = (yield* claim("back", 10, first.expiresAt + 1)).find(
        (lease) => lease.payload.automationId === REVIEW
      )
      if (back === undefined) throw new Error("The expired review claim did not come back")
      const reheld = yield* holdOf(back.id)
      yield* Effect.promise(async () =>
        queue.jobs.fail({
          ...back,
          failedAt: first.expiresAt + 2,
          error: "Made-up failure",
          retryAt: null
        })
      )
      const [failed] = yield* sql<{ readonly outcome: string }>`
        SELECT outcome FROM automation_runs WHERE id = ${back.payload.automationRunId}`
      const retries = yield* sql<{ readonly event_type: string; readonly later: number }>`
        SELECT json_extract(context, '$.trigger_context_snapshot.event_type') AS event_type,
          next_attempt_at > ${new Date(first.expiresAt + 2).toISOString()} AS later
        FROM automation_event_queue WHERE task_id = ${REVIEW}`
      const retry = (yield* claim("retry", 10, first.expiresAt + 24 * 60 * 60_000)).find(
        (lease) => lease.payload.automationId === REVIEW
      )
      if (retry === undefined) throw new Error("The retry was not claimed")
      yield* sql`PRAGMA foreign_keys = OFF`
      yield* sql`DELETE FROM spaces WHERE space_id = 'space-1'`
      yield* sql`PRAGMA foreign_keys = ON`
      const settled = yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.fail({
            ...retry,
            failedAt: first.expiresAt + 24 * 60 * 60_000 + 1,
            error: "Gone",
            retryAt: null
          })
        ).then(
          () => "settled",
          (error: unknown) => `refused: ${String(error)}`
        )
      )
      const [gone] = yield* sql<{ readonly outcome: string }>`
        SELECT outcome FROM automation_runs WHERE id = ${retry.payload.automationRunId}`
      return {
        heldFromClaim: held?.hold_started_at === held?.claimed_at,
        listed: {
          name: listed?.name,
          enabled: listed?.enabled,
          held: listed?.held_by_worker_since === held?.hold_started_at,
          chat: listed?.session_id === first.payload.sessionId
        },
        reclaimed: {
          sameRow: back.id === first.id,
          sameAttempt: back.payload.automationRunId === first.payload.automationRunId,
          sameHoldStart: reheld?.hold_started_at === held?.hold_started_at,
          claimMoved: reheld?.claimed_at !== held?.claimed_at
        },
        failed: failed?.outcome,
        retries,
        settled,
        gone: gone?.outcome,
        queuedAtEnd: yield* reviewWakes,
        definitions:
          (yield* sql`SELECT task_id FROM scheduled_tasks WHERE purpose = 'space_review'`).length
      }
    })
  )
  expect(outcome).toEqual({
    heldFromClaim: true,
    listed: { name: "Made-up worker", enabled: 1, held: true, chat: true },
    reclaimed: { sameRow: true, sameAttempt: true, sameHoldStart: true, claimMoved: true },
    failed: "failed",
    retries: [{ event_type: "space.review_retry", later: 1 }],
    settled: "settled",
    gone: "failed",
    queuedAtEnd: 0,
    definitions: 0
  })
})

it("a Space rename renames the review's generated chat, keeps a custom one, and writes no definition row", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
        VALUES ('space-1', 'Made-up', 'made-up', '{"enabled":true}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
      yield* sql`INSERT INTO scheduled_tasks (task_id, automation_ref, name, description, prompt, context_mode,
          triggers, enabled, created_at, auto_approve, builtin, tool_scope, triggers_source, purpose, owner_space_id)
        VALUES (${REVIEW}, 'internal-job~legacy', 'Made-up worker', 'Internal Space execution', 'Review it.', 'fresh',
          '[]', 1, '2026-11-01T00:00:00.000Z', 0, 1, 'all', 'space_runtime', 'space_review', 'space-1')`
      yield* guardDefinitions
      yield* spaces.bindPage("space-1", freePage("page-1", "projects/made-up.md"))
      const task = yield* (yield* WorkStore).create(
        { kind: "space", spaceId: "space-1" },
        { key: "background", text: "In the background" }
      )
      const chatName = sql<{ readonly name: string | null }>`
        SELECT session.name FROM space_review_chats AS review
        JOIN sessions AS session ON session.session_id = review.session_id
        WHERE review.space_id = 'space-1'`.pipe(Effect.map((rows) => rows[0]?.name))
      const rename = (name: string) =>
        Effect.gen(function* () {
          const [space] = yield* sql<{ readonly updated_at: string }>`
            SELECT updated_at FROM spaces WHERE space_id = 'space-1'`
          yield* spaces.update("space-1", { name, expected_updated_at: space?.updated_at ?? "" })
        })
      const generated = yield* chatName
      yield* rename("Renamed")
      const followed = yield* chatName
      const [chat] = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM space_review_chats WHERE space_id = 'space-1'`
      if (chat === undefined) throw new Error("The review has no private chat")
      yield* (yield* SessionStore).rename(chat.session_id, "My review notes")
      yield* rename("Renamed again")
      yield* editByHand(task.item_id, "Edited by hand")
      const custom = yield* chatName

      const review = (yield* claim("first", 10)).find(
        (lease) => lease.payload.automationId === REVIEW
      )
      if (review === undefined) throw new Error("The review was not claimed")
      const started = yield* startJob(review, "review-1")
      const policy = yield* ApprovalPolicyStore
      const [stored] = yield* sql<{ readonly authority_json: string | null }>`
        SELECT authority_json FROM chat_runs WHERE run_id = ${started.run.runId}`
      const authority = storedAuthority(stored?.authority_json ?? null)
      if (authority === undefined) throw new Error("The review run has no authority")
      const live = yield* policy.live({ runId: started.run.runId, authority })
      return {
        generated,
        followed,
        custom,
        sameChat: review.payload.sessionId === chat.session_id,
        session: yield* policy.session(chat.session_id),
        defaultMode: yield* policy.defaultMode(),
        follows: authority.approval.follows,
        live: { state: live.state, mode: live.mode, currentScope: live.currentScope },
        legacy: yield* sql`SELECT name, enabled, tool_scope, auto_approve FROM scheduled_tasks
          WHERE task_id = ${REVIEW}`
      }
    })
  )
  expect(outcome).toEqual({
    generated: "Made-up worker",
    followed: "Renamed worker",
    custom: "My review notes",
    sameChat: true,
    session: {
      kind: "automation",
      automation_id: REVIEW,
      tool_scope: "space",
      auto_approve: true,
      approval_mode: outcome.defaultMode
    },
    defaultMode: expect.any(String),
    follows: { kind: "space_thread", space_id: "space-1" },
    live: { state: "active", mode: outcome.defaultMode, currentScope: "space" },
    legacy: [{ name: "Made-up worker", enabled: 1, tool_scope: "all", auto_approve: 0 }]
  })
})

it("a Space review holds while it may not run, wakes once when it may, and stops on archive", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const spaces = yield* SpaceStore
      yield* guardDefinitions
      const task = yield* makeSpace
      yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
        VALUES ('space-2', 'Other', 'other', '{"enabled":true}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
      yield* sql`DELETE FROM automation_event_queue`
      const setInference = (enabled: boolean) =>
        sql.unsafe(`UPDATE spaces SET inference_policy = json_set(inference_policy, '$.enabled', json('${enabled}'))
          WHERE space_id = 'space-1'`)

      yield* setInference(false)
      yield* editByHand(task.item_id, "While off")
      const whileOff = yield* reviewWakes
      yield* setInference(true)
      yield* editByHand(task.item_id, "On again")
      yield* editByHand(task.item_id, "On again, twice")
      const whileOn = yield* reviewWakes
      yield* setInference(false)
      const heldClaim = (yield* claim("held", 10)).filter(
        (lease) => lease.payload.automationId === REVIEW
      )
      const keptWhileHeld = yield* reviewWakes
      yield* setInference(true)
      const resumed = (yield* claim("resumed", 10)).filter(
        (lease) => lease.payload.automationId === REVIEW
      )
      const resumedAgain = (yield* claim("resumed-again", 10)).filter(
        (lease) => lease.payload.automationId === REVIEW
      )
      const [running] = resumed
      if (running === undefined) throw new Error("The re-enabled review was not claimed")
      yield* spaces.archive("space-1")
      const [attempt] = yield* sql<{ readonly outcome: string }>`
        SELECT outcome FROM automation_runs WHERE id = ${running.payload.automationRunId}`
      const queue = yield* AutomationQueue
      const renewed = yield* Effect.promise(async () =>
        Promise.resolve(
          queue.jobs.renew({
            ...running,
            workerId: "resumed",
            now: LATER + 1_000,
            leaseDurationMs: 60_000
          })
        ).then(
          () => "renewed",
          () => "refused"
        )
      )
      return {
        whileOff,
        whileOn,
        heldClaim: heldClaim.length,
        keptWhileHeld,
        resumed: resumed.length,
        resumedAgain: resumedAgain.length,
        archivedAttempt: attempt?.outcome,
        renewed,
        queuedAfterArchive: yield* reviewWakes,
        definitions:
          (yield* sql`SELECT task_id FROM scheduled_tasks WHERE purpose = 'space_review'`).length
      }
    })
  )
  expect(outcome).toEqual({
    whileOff: 0,
    whileOn: 1,
    heldClaim: 0,
    keptWhileHeld: 1,
    resumed: 1,
    resumedAgain: 0,
    archivedAttempt: "superseded",
    renewed: "refused",
    queuedAfterArchive: 0,
    definitions: 0
  })
})
