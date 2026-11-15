import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { TaskProposalStore } from "../src/persistence/proposals/store.js"
import type { SpaceTaskSource } from "@arden-hq/protocol/spaces/work"
import {
  HOME_OFFER_SOURCES,
  OFFER_EXPIRY_HOURS,
  OFFER_LATER_HOURS,
  storedOfferStands,
  UNFINISHED_TURN
} from "../src/persistence/sqlite/offer-rules.js"
import { REFUSED_PROPOSAL_STATUSES } from "../src/persistence/sqlite/status-sets.js"
import { makeHomeEvidence } from "../src/persistence/sqlite/home-evidence.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { SpaceReviewStore } from "../src/persistence/automations/space-review-store.js"
import { buildSpaceReviewInput } from "../src/automations/space-review-input.js"
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

it("leaves an offer the owner put off out of Home's evidence until it is back", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const proposals = yield* TaskProposalStore
      const homeEvidence = makeHomeEvidence({ sql, consistent: (read) => read })
      const offers = () =>
        homeEvidence({ since: at(100) }).pipe(
          Effect.map((page) =>
            page.entries.flatMap((entry) => (entry.kind === "offer" ? [entry.id] : []))
          )
        )
      yield* homeOffer(sql, "offer_a", "offered", 3, 1)
      yield* homeOffer(sql, "offer_b", "offered", 2, 2)
      const before = yield* offers()
      yield* proposals.resolve(
        "offer_a",
        { client_id: "client-x", decision: "later", expected_revision: 0 },
        { memory: [] }
      )
      const putOff = yield* offers()
      yield* sql`UPDATE task_proposals SET put_off_until = ${at(1)} WHERE proposal_id = 'offer_a'`
      const back = yield* offers()
      return { before, putOff, back }
    })
  )
  expect(outcome.before).toEqual(["offer:offer_b", "offer:offer_a"])
  expect(outcome.putOff).toEqual(["offer:offer_b"])
  expect(outcome.back).toEqual(["offer:offer_b", "offer:offer_a"])
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

const SOURCE = join(import.meta.dirname, "../src")

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

// "Rejected or expired" is one fact with one owner: the Space review lists those offers as
// refused, and `propose` finds them by Task key and answers with them unchanged.
it("writes the set of refused offer statuses once, and every one of them stands", () => {
  const pair = /[[(]\s*(["'])(?:rejected\1,\s*\1expired|expired\1,\s*\1rejected)\1\s*[\])]/u
  const owners = sourceFiles(SOURCE)
    .map((path) => relative(SOURCE, path))
    .filter((path) => !path.startsWith("persistence/migrations/"))
    .filter((path) => pair.test(readFileSync(join(SOURCE, path), "utf8")))
  expect(owners).toEqual(["persistence/sqlite/status-sets.ts"])
  for (const status of REFUSED_PROPOSAL_STATUSES)
    expect(
      storedOfferStands(
        {
          status,
          evidence_revision_key: "old-evidence",
          candidate_hash: "old-candidate",
          retired_evidence_key: null
        },
        { evidenceKey: "new-evidence", candidateHash: "new-candidate" }
      )
    ).toBe(true)
})

// Where the two tracks meet: a new owner turn wakes the Space review, the review's admission
// starts on it, and the worker's offer citing that turn is admitted. Admission and the offer
// check each have their own tests; this one keeps them agreeing about which turns count.
it("offers from the finished owner turn that started the Space review", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const queue = yield* AutomationQueue
      const reviews = yield* SpaceReviewStore
      const proposals = yield* TaskProposalStore
      yield* space(sql)
      yield* turn(sql, {
        id: "run-1",
        turn: "turn-1",
        status: "completed",
        owner: true,
        hoursAgo: 2
      })
      const review = yield* catalog.create(
        {
          history: "fresh",
          name: "Space review",
          prompt: "Review the Space",
          triggers: [{ type: "event", event_type: "task.changed" }],
          idempotency_key: "5f0d7c2a-3b1e-4c8d-9a6f-2e4b1d0c7b01",
          idempotency_scope: "global"
        },
        "owner"
      )
      yield* sql`UPDATE scheduled_tasks SET purpose = 'space_review', owner_space_id = 'space-1'
        WHERE task_id = ${review.task_id}`
      yield* sql`INSERT INTO automation_event_queue (task_id, source, event_key, context, created_at,
          claimed_at, attempt_count, last_error, next_attempt_at)
        VALUES (${review.task_id}, 'wake', 'wake-1', '{"scheduled_for":null,"automation_run_id":null}',
          ${at(0)}, NULL, 0, NULL, NULL)`
      const [lease] = yield* Effect.promise(async () =>
        queue.jobs.claim({
          workerId: "meeting",
          now: Date.now(),
          limit: 1,
          leaseDurationMs: 60_000
        })
      )
      if (lease === undefined) throw new Error("the Space review was not claimed")
      const input = yield* reviews.prepareSpaceReview(
        lease,
        buildSpaceReviewInput({ head: null, pages: [] })
      )
      const [policy] = yield* sql<{ readonly generation: number }>`
        SELECT policy_generation AS generation FROM spaces WHERE space_id = 'space-1'`
      yield* sql`INSERT INTO execution_budgets (budget_id) VALUES ('budget-review')`
      yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
          metadata_json, assistant_message_id, client_id)
        VALUES ('review-run', 'chat-1', 'running', ${at(0)}, ${at(0)}, ${JSON.stringify({
          turn_id: "review-turn",
          run_policy: {
            budget_id: "budget-review",
            space: {
              space_id: "space-1",
              generation: policy?.generation,
              inference: { enabled: true }
            }
          },
          run_context: {
            origin: { kind: "space", space_id: "space-1", occurrence_id: "wake-1" },
            task: null
          }
        })}, 'assistant-review-run', 'client-review-run')`
      const read = { sql, consistent: <A, E>(effect: Effect.Effect<A, E>) => effect }
      const offer = yield* proposals.propose({
        spaceId: "space-1",
        runId: "review-run",
        sessionId: "chat-1",
        toolCallId: "call-review",
        input: { key: "made-up-follow-up", text: "Do the made-up follow-up" },
        capture: { basis: "inferred", reason: "Made up." },
        sources: input.reads.chats.map((chat) => ({
          kind: "chat" as const,
          session_id: chat.sessionId,
          turn_id: chat.turnId,
          revision: chat.turnId
        })),
        inferenceSnapshot: (yield* readInferenceReview(read, "space-1")).snapshot
      })
      // The owner accepting the offer by hand is a Task change made by hand: it wakes the review.
      yield* sql`UPDATE spaces SET page_id = 'page-1', page_path = 'projects/made-up.md'
        WHERE space_id = 'space-1'`
      yield* proposals.resolve(
        offer.proposal_id,
        { expected_revision: offer.revision, client_id: "accept-1", decision: "accept" },
        { memory: [] }
      )
      const wakes = yield* sql<{ readonly event_type: string }>`
        SELECT json_extract(context, '$.trigger_context_snapshot.event_type') AS event_type
        FROM automation_event_queue WHERE task_id = 'space:space-1'`
      return { input, offer, wakes: wakes.map((wake) => wake.event_type) }
    })
  )
  expect(outcome.input.admission).toBe("changed")
  expect(outcome.input.reads.chats.map((chat) => chat.turnId)).toEqual(["turn-1"])
  expect(outcome.offer).toMatchObject({ place: "space", status: "offered" })
  expect(outcome.wakes).toEqual(["space.wake"])
})
