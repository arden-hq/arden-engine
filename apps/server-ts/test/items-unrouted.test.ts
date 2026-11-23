import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ConnectionItemStore } from "../src/persistence/connections/store.js"
import { DayActivity } from "../src/persistence/automations/day-activity.js"
import { TaskProposalStore } from "../src/persistence/proposals/store.js"
import { assertItemEvidence } from "../src/persistence/sqlite/connection-item-evidence.js"
import { homeOfferJson } from "../src/persistence/sqlite/task-proposal-home.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-11-20T00:00:00.000Z"

const mainId = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly space_id: string
  }>`SELECT space_id FROM spaces WHERE kind = 'main'`.pipe(
    Effect.map((rows) => rows[0]?.space_id ?? "")
  )

const seedItem = (sql: SqlClient.SqlClient, itemId: string) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO connection_items (item_id, source, account, external_id, thread_key,
        title, sender, received_at, snippet, fetched_at)
      VALUES (${itemId}, 'gmail', 'me', ${itemId}, ${`thread-${itemId}`}, 'Invoice', 'Ann',
        ${AT}, 'Pay it', ${AT})`
    yield* sql`INSERT INTO connection_item_threads (item_id, source, account, thread_key)
      VALUES (${itemId}, 'gmail', 'me', ${`thread-${itemId}`})`
  })

const mainOffer = (
  sql: SqlClient.SqlClient,
  offer: {
    readonly id: string
    readonly sources: string
    readonly authoredIn: { readonly session: string; readonly run: string }
  }
) =>
  Effect.gen(function* () {
    const main = yield* mainId(sql)
    const run = offer.authoredIn
    yield* sql`INSERT INTO task_proposals (proposal_id, place, space_id, dedupe_key, stable_key,
        text, owner, capture_json, sources_json, evidence_revision_key, candidate_hash,
        source_run_id, source_session_id, source_turn_id, source_tool_call_id,
        capture_policy_json, revision, seq, status, created_at, updated_at)
      VALUES (${offer.id}, 'space', ${main}, ${offer.id}, ${offer.id}, 'Reply to Ann', 'worker',
        '{"basis":"inferred","reason":"Ann asked."}', ${offer.sources}, ${offer.id}, ${offer.id},
        ${run.run}, ${run.session}, 'turn-1', 'call-1',
        '{"origin":"automation","task_item_id":null,"task_generation":null}',
        0, 1, 'offered', ${AT}, ${AT})`
  })

const chatWithTurn = (
  sql: SqlClient.SqlClient,
  chat: {
    readonly session: string
    readonly run: string
    readonly spaceId: string | null
  }
) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
        session_type, space_id, origin_automation_id)
      VALUES (${chat.session}, ${chat.session}, ${AT}, ${AT},
        ${chat.spaceId === null ? "channel" : "chat"}, ${chat.spaceId},
        ${chat.spaceId === null ? "daily" : null})`
    yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
        ended_at, metadata_json, assistant_message_id)
      VALUES (${chat.run}, ${chat.session}, 'completed', ${AT}, ${AT}, ${AT},
        json_object('turn_id', 'turn-1',
          'run_policy', json_object('space', json_object('space_id', ${chat.spaceId}))),
        ${`assistant-${chat.run}`})`
  })

const start = (proposalId: string, spaceId?: string) =>
  Effect.gen(function* () {
    const proposals = yield* TaskProposalStore
    const sql = yield* SqlClient.SqlClient
    const { task } = yield* proposals.resolve(
      proposalId,
      {
        expected_revision: 0,
        client_id: `start-${proposalId}`,
        decision: "accept",
        ...(spaceId === undefined ? {} : { space_id: spaceId })
      },
      { memory: [] }
    )
    const rows = yield* sql<{
      readonly space_id: string
    }>`SELECT space_id FROM space_tasks
      WHERE item_id = ${task?.item_id ?? ""}`
    return rows[0]?.space_id
  })

it("a Main offer from a run with no Space starts on Main or on the Space picked, with no Memory scope", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const proposals = yield* TaskProposalStore
      yield* sql`INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
        VALUES ('work', 'Work', 'work', ${AT}, ${AT})`
      yield* chatWithTurn(sql, {
        session: "automation",
        run: "automation-run",
        spaceId: null
      })
      const turn = JSON.stringify([
        {
          kind: "chat",
          session_id: "automation",
          turn_id: "turn-1",
          revision: "turn-1"
        }
      ])
      const authoredIn = { session: "automation", run: "automation-run" }
      yield* mainOffer(sql, {
        id: "automation-main",
        sources: turn,
        authoredIn
      })
      yield* mainOffer(sql, {
        id: "automation-work",
        sources: turn,
        authoredIn
      })
      const main = yield* mainId(sql)
      const label = (spaceId: string | undefined) => (spaceId === main ? "main" : spaceId)
      return {
        memoryScope: yield* proposals.memoryScope("automation-main"),
        main: label(yield* start("automation-main")),
        work: label(yield* start("automation-work", "work"))
      }
    })
  )
  expect(outcome).toEqual({
    memoryScope: undefined,
    main: "main",
    work: "work"
  })
})

it("a Main chat's offer citing a stored item starts, and item evidence needs only a stored item", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainId(sql)
      yield* seedItem(sql, "item-1")
      yield* chatWithTurn(sql, {
        session: "main-chat",
        run: "main-run",
        spaceId: main
      })
      yield* mainOffer(sql, {
        id: "main-chat-offer",
        sources: JSON.stringify([
          {
            kind: "chat",
            session_id: "main-chat",
            turn_id: "turn-1",
            revision: "turn-1"
          },
          { kind: "connection_item", item_id: "item-1", revision: "item-1" }
        ]),
        authoredIn: { session: "main-chat", run: "main-run" }
      })
      const scope = yield* (yield* TaskProposalStore).memoryScope("main-chat-offer")
      const started = yield* start("main-chat-offer")
      const evidence = (itemId: string) =>
        assertItemEvidence(sql, {
          proposalId: undefined,
          sources: [{ kind: "connection_item", item_id: itemId, revision: itemId }]
        }).pipe(
          Effect.as("accepted"),
          Effect.catch((error) => Effect.succeed(error.message))
        )
      yield* seedItem(sql, "item-2")
      return {
        memoryInMain: scope === main,
        started: started === main,
        stored: yield* evidence("item-2"),
        unknown: yield* evidence("item-3")
      }
    })
  )
  expect(outcome).toEqual({
    memoryInMain: true,
    started: true,
    stored: "accepted",
    unknown: "That item is not stored, so it cannot be evidence"
  })
})

it("a fetch stores items with no routing step, and the Daily note lists them without a Space", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const items = yield* ConnectionItemStore
      const day = yield* DayActivity
      const saved = yield* items.saveFetch({
        source: "gmail",
        account: "me",
        cursor: "c1",
        pollAfter: undefined,
        since: undefined,
        items: [
          {
            source: "gmail",
            account: "me",
            externalId: "m1",
            threadKey: "t1",
            title: "Invoice",
            sender: "Ann",
            receivedAt: AT,
            snippet: "Pay it",
            detail: undefined
          }
        ]
      })
      const read = yield* day.read({
        start: "2026-11-19T12:00:00.000Z",
        end: "2026-11-20T12:00:00.000Z"
      })
      return {
        saved,
        items: read.items.map(({ itemId: _itemId, ...item }) => item)
      }
    })
  )
  expect(outcome).toEqual({
    saved: { inserted: 1 },
    items: [
      {
        source: "gmail",
        receivedAt: AT,
        sender: "Ann",
        title: "Invoice",
        snippet: "Pay it",
        sentByOwner: false
      }
    ]
  })
})

it("Main letter evidence names the item an offer cites, whatever source comes first", async () => {
  const cited = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seedItem(sql, "item-1")
      yield* chatWithTurn(sql, {
        session: "automation",
        run: "automation-run",
        spaceId: null
      })
      yield* mainOffer(sql, {
        id: "offer",
        sources: JSON.stringify([
          {
            kind: "chat",
            session_id: "automation",
            turn_id: "turn-1",
            revision: "turn-1"
          },
          { kind: "connection_item", item_id: "item-1", revision: "item-1" }
        ]),
        authoredIn: { session: "automation", run: "automation-run" }
      })
      yield* sql`UPDATE task_proposals SET signal_json = json_object('source', 'gmail',
        'title', 'Invoice', 'from', 'Ann')`
      const rows = yield* sql<{
        readonly offer: string
      }>`SELECT ${homeOfferJson(sql)} AS offer
        FROM task_proposals AS offer`
      return JSON.parse(rows[0]?.offer ?? "{}").item.item_id
    })
  )
  expect(cited).toBe("item-1")
})

it("Start refuses an offer whose cited item expired, on both start paths", async () => {
  const refused = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainId(sql)
      yield* chatWithTurn(sql, {
        session: "automation",
        run: "automation-run",
        spaceId: null
      })
      yield* chatWithTurn(sql, {
        session: "main-chat",
        run: "main-run",
        spaceId: main
      })
      const sources = (session: string) =>
        JSON.stringify([
          {
            kind: "chat",
            session_id: session,
            turn_id: "turn-1",
            revision: "turn-1"
          },
          { kind: "connection_item", item_id: "gone", revision: "gone" }
        ])
      yield* mainOffer(sql, {
        id: "no-space",
        sources: sources("automation"),
        authoredIn: { session: "automation", run: "automation-run" }
      })
      yield* mainOffer(sql, {
        id: "in-main",
        sources: sources("main-chat"),
        authoredIn: { session: "main-chat", run: "main-run" }
      })
      const kind = (proposalId: string) =>
        start(proposalId).pipe(
          Effect.flip,
          Effect.map((error) => ("kind" in error ? error.kind : error.reason))
        )
      return {
        noSpace: yield* kind("no-space"),
        inMain: yield* kind("in-main")
      }
    })
  )
  expect(refused).toEqual({
    noSpace: "source_unavailable",
    inMain: "source_unavailable"
  })
})

it("Main letter evidence names no item when the first one an offer cites expired", async () => {
  const cited = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seedItem(sql, "item-2")
      yield* chatWithTurn(sql, {
        session: "automation",
        run: "automation-run",
        spaceId: null
      })
      yield* mainOffer(sql, {
        id: "offer",
        sources: JSON.stringify([
          { kind: "connection_item", item_id: "item-1", revision: "item-1" },
          { kind: "connection_item", item_id: "item-2", revision: "item-2" }
        ]),
        authoredIn: { session: "automation", run: "automation-run" }
      })
      yield* sql`UPDATE task_proposals SET signal_json = json_object('source', 'gmail',
        'title', 'Invoice', 'from', 'Ann')`
      const rows = yield* sql<{ readonly item_id: string | null }>`SELECT
        json_extract(${homeOfferJson(sql)}, '$.item.item_id') AS item_id
        FROM task_proposals AS offer`
      return rows[0]?.item_id
    })
  )
  expect(cited).toBeNull()
})
