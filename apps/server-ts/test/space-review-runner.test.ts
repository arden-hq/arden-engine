import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { makeAutomationMessage } from "../src/chat/message-input.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { spaceJobId } from "../src/persistence/space-job-id.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { freePage } from "./fixtures/free-space-page.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { LATER, claim, type Lease } from "./work-fixtures.js"

const REVIEW = spaceJobId("space-1")

const guardDefinitions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const event of ["INSERT", "UPDATE"])
    yield* sql.unsafe(`CREATE TRIGGER reject_synthetic_space_review_${event.toLowerCase()}
      BEFORE ${event} ON scheduled_tasks WHEN NEW.purpose = 'space_review'
      BEGIN SELECT RAISE(ABORT, 'reject_synthetic_space_review: a Space review definition row was written'); END`)
})

const startIn = (lease: Lease, sessionId: string, id: string) =>
  Effect.gen(function* () {
    const chat = yield* ChatWriteStore
    const automation = {
      automationId: AutomationId.make(lease.payload.automationId),
      attemptId: lease.payload.automationRunId,
      name: lease.payload.name
    }
    const automationLease = { id: lease.id, token: lease.token }
    const message = yield* makeAutomationMessage({
      sessionId,
      clientId: id,
      prompt: "Made-up prompt",
      automation,
      contextMode: "fresh",
      lease: automationLease
    })
    return yield* chat
      .start({
        sessionId,
        clientId: id,
        requestHash: `${id}-hash`,
        assistantMessageId: `${id}-answer`,
        message,
        automation,
        automationLease,
        automationPrompt: "Made-up prompt",
        automationContextMode: "fresh"
      })
      .pipe(
        Effect.match({
          onFailure: (error) => ({ kind: "refused" as const, message: String(error) }),
          onSuccess: (started) =>
            started._tag === "Started"
              ? { kind: "started" as const, runId: started.runId, messages: started.activeMessages }
              : { kind: "refused" as const, message: started._tag }
        })
      )
  })

const prepare = (lease: Lease) =>
  Effect.gen(function* () {
    return yield* (yield* AutomationQueue).prepareRunSession(lease).pipe(
      Effect.match({
        onFailure: (error) => ({ kind: "refused" as const, message: error.message }),
        onSuccess: (sessionId) => ({ kind: "prepared" as const, sessionId })
      })
    )
  })

const childOf = (result: Effect.Success<ReturnType<typeof prepare>>): string => {
  if (result.kind === "prepared" && result.sessionId !== undefined) return result.sessionId
  throw new Error("The review was not given a child chat")
}

const editByHand = (itemId: string, text: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly updated_at: string }>`
      SELECT updated_at FROM space_tasks WHERE item_id = ${itemId}`
    yield* (yield* WorkStore).update({ kind: "item", itemId }, row?.updated_at ?? "", { text })
  })

const runnerCase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
      VALUES ('space-1', 'Made-up', 'made-up', '{"enabled":true}', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
  yield* guardDefinitions
  yield* (yield* SpaceStore).bindPage("space-1", freePage("page-1", "projects/made-up.md"))
  const task = yield* (yield* WorkStore).create(
    { kind: "space", spaceId: "space-1" },
    { key: "background", text: "In the background" }
  )
  yield* editByHand(task.item_id, "Edited by hand")
  const first = (yield* claim("first", 10)).find((lease) => lease.payload.automationId === REVIEW)
  if (first === undefined) throw new Error("The review was not claimed")
  const trunk = first.payload.sessionId
  if (trunk === null) throw new Error("The review has no trunk chat")
  const prepared = yield* prepare(first)
  const preparedAgain = yield* prepare(first)
  const child = childOf(prepared)
  const forgedId = "forged-child"
  yield* sql`INSERT INTO sessions (session_id, public_ref, name, started_at, last_activity,
        session_type, origin_automation_id, parent_session_id, space_id)
      VALUES (${forgedId}, 'forged-ref', NULL, '2026-11-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z', 'chat', ${REVIEW}, ${trunk}, 'space-1')`
  const forged = yield* startIn(first, forgedId, "forged")
  const started = yield* startIn(first, child, "review-1")
  if (started.kind !== "started")
    throw new Error(`The review did not start in its child: ${started.message}`)
  const [attempt] = yield* sql<{
    readonly chat_session_id: string | null
    readonly chat_run_id: string | null
  }>`
      SELECT chat_session_id, chat_run_id FROM automation_runs WHERE id = ${first.payload.automationRunId}`
  const [childRow] = yield* sql<{
    readonly session_type: string
    readonly parent_session_id: string | null
    readonly origin_automation_id: string | null
    readonly space_id: string | null
  }>`SELECT session_type, parent_session_id, origin_automation_id, space_id FROM sessions
      WHERE session_id = ${child}`
  const chat = yield* ChatWriteStore
  yield* chat.finish({
    runId: started.runId,
    messages: [
      ...started.messages,
      {
        message_id: "review-1-answer",
        role: "assistant",
        content: "Made-up result",
        created_at: new Date().toISOString()
      }
    ]
  })
  const queue = yield* AutomationQueue
  yield* Effect.promise(async () =>
    queue.jobs.complete({
      ...first,
      completedAt: LATER + 1_000,
      result: {
        status: "ended",
        outcome: "finished",
        result: "Made-up result",
        error: null,
        chatRunId: started.runId,
        chatSessionId: child
      }
    })
  )
  yield* editByHand(task.item_id, "Edited by hand again")
  const second = (yield* claim("second", 10, LATER + 2 * 60 * 60_000)).find(
    (lease) => lease.payload.automationId === REVIEW
  )
  if (second === undefined) throw new Error("The second change did not wake the review")
  const stale = yield* startIn(second, child, "stale-child")
  const preparedSecond = yield* prepare(second)
  const secondChild = childOf(preparedSecond)
  const startedSecond = yield* startIn(second, secondChild, "review-2")
  return {
    prepared:
      prepared.kind === "prepared"
        ? prepared.sessionId !== trunk && prepared.sessionId !== undefined
        : prepared.message,
    preparedAgainSame: preparedAgain.kind === "prepared" && preparedAgain.sessionId === child,
    childRow,
    childIsTrunks: childRow?.parent_session_id === trunk,
    forged: forged.kind,
    started: started.kind,
    attemptPinnedToChild:
      attempt?.chat_session_id === child && attempt?.chat_run_id === started.runId,
    stale: stale.kind,
    secondChild: secondChild !== child && secondChild !== trunk,
    sameTrunk: second.payload.sessionId === trunk,
    startedSecond: startedSecond.kind,
    children: (yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM sessions
        WHERE parent_session_id = ${trunk} AND session_id != ${forgedId}`)[0]?.n,
    oldRows: (yield* sql`SELECT task_id FROM scheduled_tasks WHERE purpose = 'space_review'`).length
  }
})

const expected = {
  prepared: true,
  preparedAgainSame: true,
  childRow: {
    session_type: "chat",
    parent_session_id: expect.any(String),
    origin_automation_id: REVIEW,
    space_id: "space-1"
  },
  childIsTrunks: true,
  forged: "refused",
  started: "started",
  attemptPinnedToChild: true,
  stale: "refused",
  secondChild: true,
  sameTrunk: true,
  startedSecond: "started",
  children: 2,
  oldRows: 0
}

it("the normal worker's run chat for a review: a child per attempt under the private trunk, no definition row", async () => {
  expect(await withTempDatabase(runnerCase)).toEqual(expected)
})
