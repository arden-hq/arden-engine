import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { TaskProposalStore } from "../src/persistence/proposals/store.js"
import { OFFER_EXPIRY_HOURS, UNFINISHED_TURN } from "../src/persistence/sqlite/offer-rules.js"
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

it("expires offers left unanswered past the age, moves held Home offers up, and starts nothing", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const proposals = yield* TaskProposalStore
      const offer = (id: string, status: "offered" | "held", hoursAgo: number, seq: number) =>
        sql`INSERT INTO task_proposals (proposal_id, place, dedupe_key, stable_key, text, owner,
            capture_json, sources_json, evidence_revision_key, candidate_hash, revision, seq,
            status, created_at, updated_at)
          VALUES (${id}, 'home', ${`home:${id}`}, ${`offer-${seq}`}, 'Made-up offer', 'worker',
            '{"basis":"inferred","reason":"Made up."}', '[]', ${`home:${id}`}, ${`home:${id}`}, 0,
            ${seq}, ${status}, ${at(hoursAgo)}, ${at(hoursAgo)})`
      yield* offer("offer_old_1", "offered", OFFER_EXPIRY_HOURS + 300, 1)
      yield* offer("offer_old_2", "offered", OFFER_EXPIRY_HOURS + 1, 2)
      yield* offer("offer_new", "offered", OFFER_EXPIRY_HOURS - 1, 3)
      for (const seq of [4, 5, 6, 7, 8, 9]) yield* offer(`offer_held_${seq}`, "held", 200, seq)
      const expired = yield* proposals.expireOffers()
      const again = yield* proposals.expireOffers()
      const rows = yield* sql<{
        readonly proposal_id: string
        readonly status: string
        readonly settled: number
      }>`SELECT proposal_id, status, settled_at IS NOT NULL AS settled
        FROM task_proposals ORDER BY seq`
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
      return { expired, again, rows, started, answer }
    })
  )
  expect(outcome.expired).toBe(2)
  expect(outcome.again).toBe(0)
  expect(outcome.rows.map((row) => [row.proposal_id, row.status, row.settled])).toEqual([
    ["offer_old_1", "expired", 1],
    ["offer_old_2", "expired", 1],
    ["offer_new", "offered", 0],
    ["offer_held_4", "offered", 0],
    ["offer_held_5", "offered", 0],
    ["offer_held_6", "offered", 0],
    ["offer_held_7", "offered", 0],
    ["offer_held_8", "held", 0],
    ["offer_held_9", "held", 0]
  ])
  expect(outcome.started).toEqual({ runs: 0, jobs: 0 })
  expect(outcome.answer).toMatchObject({ kind: "settled" })
})
