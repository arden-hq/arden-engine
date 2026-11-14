import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { TaskProposalStore } from "../src/persistence/proposals/store.js"
import type { SpaceTaskSource } from "@arden-hq/protocol/spaces/work"
import {
  HOME_OFFER_SOURCES,
  OFFER_EXPIRY_HOURS,
  OFFER_LATER_HOURS,
  UNFINISHED_TURN
} from "../src/persistence/sqlite/offer-rules.js"
import {
  assertCitedTurnsFinished,
  readInferenceReview
} from "../src/persistence/sqlite/work-inference.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const HOUR = 3_600_000
const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString()

const turn = (
  sql: SqlClient.SqlClient,
  run: {
    readonly id: string
    readonly turn: string
    readonly status: "completed" | "running"
    readonly owner: boolean
    readonly hoursAgo: number
  }
) => {
  const time = at(run.hoursAgo)
  const message = JSON.stringify(
    run.owner
      ? { role: "user", content: "made-up owner words" }
      : { role: "user", content: "made-up result", is_meta: true }
  )
  return Effect.gen(function* () {
    yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, ended_at,
        metadata_json, assistant_message_id, client_id)
      VALUES (${run.id}, 'chat-1', ${run.status}, ${time}, ${time},
        ${run.status === "completed" ? time : null}, ${JSON.stringify({ turn_id: run.turn })},
        ${`assistant-${run.id}`}, ${`client-${run.id}`})`
    yield* sql`INSERT INTO chat_idempotency_keys (session_id, client_id, request_hash, run_id,
        message_id, message_json, status, created_at, updated_at)
      VALUES ('chat-1', ${`client-${run.id}`}, 'request', ${run.id}, ${`message-${run.id}`},
        ${message}, ${run.status}, ${time}, ${time})`
  })
}

const space = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
      VALUES ('space-1', 'Made-up Space', 'made-up space', '{"enabled":true}', ${at(100)}, ${at(100)})`
    yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type, space_id)
      VALUES ('chat-1', 'chat-ref-1', ${at(100)}, ${at(1)}, 'chat', 'space-1')`
  })

const cite = (turnId: string) => [
  { kind: "chat" as const, session_id: "chat-1", turn_id: turnId, revision: turnId }
]

it("admits a finished owner turn after a result lands, and refuses while the cited turn runs", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const read = { sql, consistent: <A, E>(effect: Effect.Effect<A, E>) => effect }
      yield* space(sql)
      yield* turn(sql, {
        id: "run-1",
        turn: "turn-1",
        status: "completed",
        owner: true,
        hoursAgo: 3
      })
      const reviewed = (yield* readInferenceReview(read, "space-1")).snapshot
      yield* turn(sql, {
        id: "run-2",
        turn: "turn-2",
        status: "completed",
        owner: false,
        hoursAgo: 2
      })
      const afterResult = (yield* readInferenceReview(read, "space-1")).snapshot
      const finished = yield* Effect.exit(assertCitedTurnsFinished(sql, cite("turn-1")))
      yield* turn(sql, { id: "run-3", turn: "turn-3", status: "running", owner: true, hoursAgo: 1 })
      const afterOwner = (yield* readInferenceReview(read, "space-1")).snapshot
      const running = yield* assertCitedTurnsFinished(sql, cite("turn-3")).pipe(Effect.flip)
      const unknown = yield* assertCitedTurnsFinished(sql, cite("turn-9")).pipe(Effect.flip)
      return { reviewed, afterResult, afterOwner, finished, running, unknown }
    })
  )
  expect(outcome.afterResult).toBe(outcome.reviewed)
  expect(outcome.finished._tag).toBe("Success")
  expect(outcome.afterOwner).not.toBe(outcome.reviewed)
  expect(outcome.running.message).toBe(UNFINISHED_TURN)
  expect(outcome.unknown.message).toBe(UNFINISHED_TURN)
})

const homeOffer = (
  sql: SqlClient.SqlClient,
  id: string,
  status: "offered" | "held",
  hoursAgo: number,
  seq: number
) =>
  sql`INSERT INTO task_proposals (proposal_id, place, dedupe_key, stable_key, text, owner,
      capture_json, sources_json, evidence_revision_key, candidate_hash, revision, seq,
      status, created_at, updated_at)
    VALUES (${id}, 'home', ${`home:${id}`}, ${`offer-${seq}`}, 'Made-up offer', 'worker',
      '{"basis":"inferred","reason":"Made up."}', '[]', ${`home:${id}`}, ${`home:${id}`}, 0,
      ${seq}, ${status}, ${at(hoursAgo)}, ${at(hoursAgo)})`

const ownerPresent = (sql: SqlClient.SqlClient) =>
  sql`INSERT INTO home_presence (client_id, sequence, last_seen_at, lease_until)
    VALUES ('client-present', 1, ${at(0)}, ${new Date(Date.now() + 30_000).toISOString()})`

const statuses = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly proposal_id: string
    readonly status: string
    readonly waiting: number
  }>`SELECT proposal_id, status, waiting_since IS NOT NULL AS waiting
    FROM task_proposals ORDER BY seq`.pipe(
    Effect.map((rows) => rows.map((row) => [row.proposal_id, row.status, row.waiting]))
  )

it("counts an offer's age from when the owner was first around to see it, and starts nothing", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const proposals = yield* TaskProposalStore
      yield* homeOffer(sql, "offer_old_1", "offered", OFFER_EXPIRY_HOURS + 300, 1)
      yield* homeOffer(sql, "offer_old_2", "offered", OFFER_EXPIRY_HOURS + 15, 2)
      yield* homeOffer(sql, "offer_new", "offered", 1, 3)
      for (const seq of [4, 5, 6, 7, 8, 9])
        yield* homeOffer(sql, `offer_held_${seq}`, "held", 200, seq)
      const away = yield* proposals.expireOffers()
      const afterAway = yield* statuses(sql)
      yield* ownerPresent(sql)
      const firstSeen = yield* proposals.expireOffers()
      const afterSeen = yield* statuses(sql)
      yield* sql`UPDATE task_proposals SET waiting_since = ${at(OFFER_EXPIRY_HOURS + 1)}
        WHERE proposal_id = 'offer_old_1'`
      const overdue = yield* proposals.expireOffers()
      const afterOverdue = yield* statuses(sql)
      const [started] = yield* sql<{ readonly runs: number; readonly jobs: number }>`SELECT
        (SELECT COUNT(*) FROM chat_runs) AS runs,
        (SELECT COUNT(*) FROM automation_event_queue) AS jobs`
      const answer = yield* proposals
        .resolve(
          "offer_old_1",
          { client_id: "client-x", decision: "reject", expected_revision: 1 },
          { memory: [] }
        )
        .pipe(Effect.flip)
      return { away, afterAway, firstSeen, afterSeen, overdue, afterOverdue, started, answer }
    })
  )
  // The owner was away the whole time: nothing expires, however old.
  expect(outcome.away).toBe(0)
  expect(outcome.afterAway.every(([, , waiting]) => waiting === 0)).toBe(true)
  // The owner comes back: every open offer starts waiting now; held ones do not.
  expect(outcome.firstSeen).toBe(0)
  expect(outcome.afterSeen.slice(0, 4)).toEqual([
    ["offer_old_1", "offered", 1],
    ["offer_old_2", "offered", 1],
    ["offer_new", "offered", 1],
    ["offer_held_4", "held", 0]
  ])
  // Waiting past the age since the owner was around: it expires and a held offer moves up.
  expect(outcome.overdue).toBe(1)
  expect(outcome.afterOverdue).toEqual([
    ["offer_old_1", "expired", 1],
    ["offer_old_2", "offered", 1],
    ["offer_new", "offered", 1],
    ["offer_held_4", "offered", 0],
    ["offer_held_5", "offered", 0],
    ["offer_held_6", "offered", 0],
    ["offer_held_7", "held", 0],
    ["offer_held_8", "held", 0],
    ["offer_held_9", "held", 0]
  ])
  expect(outcome.started).toEqual({ runs: 0, jobs: 0 })
  expect(outcome.answer).toMatchObject({ kind: "settled" })
})

it("keeps an offer the owner put off for later until it is back and waits again", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const proposals = yield* TaskProposalStore
      yield* homeOffer(sql, "offer_a", "offered", 30, 1)
      yield* ownerPresent(sql)
      yield* sql`UPDATE task_proposals SET waiting_since = ${at(30)}`
      const later = yield* proposals.resolve(
        "offer_a",
        { client_id: "client-x", decision: "later", expected_revision: 0 },
        { memory: [] }
      )
      yield* sql`UPDATE task_proposals SET waiting_since = NULL`
      const whilePutOff = yield* proposals.expireOffers()
      const putOff = yield* statuses(sql)
      yield* sql`UPDATE task_proposals SET put_off_until = ${at(1)}`
      yield* proposals.expireOffers()
      const back = yield* statuses(sql)
      return { later, whilePutOff, putOff, back }
    })
  )
  const putOffHours = (Date.parse(outcome.later.proposal.put_off_until ?? "") - Date.now()) / HOUR
  expect(outcome.later.task).toBeNull()
  expect(outcome.later.proposal).toMatchObject({ status: "offered", revision: 1 })
  expect(Math.round(putOffHours)).toBe(OFFER_LATER_HOURS)
  expect(outcome.whilePutOff).toBe(0)
  expect(outcome.putOff).toEqual([["offer_a", "offered", 0]])
  expect(outcome.back).toEqual([["offer_a", "offered", 1]])
})

const automationRun = (
  sql: SqlClient.SqlClient,
  run: { readonly id: string; readonly turn: string }
) =>
  sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, metadata_json,
      assistant_message_id, client_id)
    VALUES (${run.id}, 'automation-chat', 'running', ${at(0)}, ${at(0)},
      ${JSON.stringify({
        turn_id: run.turn,
        run_policy: { budget_id: "budget-1" },
        run_context: {
          origin: { kind: "automation", automation_id: "automation-1", occurrence_id: run.id },
          task: null
        }
      })}, ${`assistant-${run.id}`}, ${`client-${run.id}`})`

const homePropose = (
  proposals: TaskProposalStore["Service"],
  run: string,
  sources: ReadonlyArray<SpaceTaskSource>
) =>
  proposals.propose({
    spaceId: undefined,
    runId: run,
    sessionId: "automation-chat",
    toolCallId: `call-${run}`,
    input: { key: "made-up-errand", text: "Do the made-up errand" },
    capture: { basis: "inferred", reason: "Made up." },
    sources,
    inferenceSnapshot: ""
  })

it("keeps a No for the Task key when a later run cites its own new turn", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const proposals = yield* TaskProposalStore
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type)
        VALUES ('automation-chat', 'automation-ref', ${at(10)}, ${at(0)}, 'chat')`
      yield* sql`INSERT INTO execution_budgets (budget_id) VALUES ('budget-1')`
      yield* automationRun(sql, { id: "run-1", turn: "turn-1" })
      const first = yield* homePropose(proposals, "run-1", [
        { kind: "chat", session_id: "automation-chat", turn_id: "turn-1", revision: "turn-1" }
      ])
      yield* proposals.resolve(
        first.proposal_id,
        { client_id: "client-x", decision: "reject", expected_revision: first.revision },
        { memory: [] }
      )
      yield* automationRun(sql, { id: "run-2", turn: "turn-2" })
      const again = yield* homePropose(proposals, "run-2", [
        { kind: "chat", session_id: "automation-chat", turn_id: "turn-2", revision: "turn-2" }
      ])
      const pageOnly = yield* homePropose(proposals, "run-2", [
        { kind: "memory", page_ref: "made-up-page", revision: "page-1" }
      ])
      const [rows] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM task_proposals`
      return { first, again, pageOnly, rows }
    })
  )
  expect(outcome.again).toMatchObject({
    proposal_id: outcome.first.proposal_id,
    status: "rejected"
  })
  expect(outcome.rows?.count).toBe(1)
  expect(outcome.pageOnly).toMatchObject({ proposal_id: outcome.first.proposal_id })
})

it("refuses a Home offer's mail item and Memory page with one message that names what anchors it", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const proposals = yield* TaskProposalStore
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type)
        VALUES ('automation-chat', 'automation-ref', ${at(10)}, ${at(0)}, 'chat')`
      yield* sql`INSERT INTO execution_budgets (budget_id) VALUES ('budget-1')`
      yield* automationRun(sql, { id: "run-1", turn: "turn-1" })
      const page = yield* homePropose(proposals, "run-1", [
        { kind: "memory", page_ref: "made-up-page", revision: "page-1" }
      ]).pipe(Effect.flip)
      const mail = yield* homePropose(proposals, "run-1", [
        { kind: "connection_item", item_id: "made-up-mail", revision: "mail-1" }
      ]).pipe(Effect.flip)
      return { page: page.message, mail: mail.message }
    })
  )
  expect(outcome.page).toBe(HOME_OFFER_SOURCES)
  expect(outcome.mail).toBe(HOME_OFFER_SOURCES)
  expect(HOME_OFFER_SOURCES).not.toMatch(/mail|Memory page it read/u)
})
