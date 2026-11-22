import type { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ConnectionItemStore } from "../src/persistence/connections/store.js"
import { DayActivity } from "../src/persistence/automations/day-activity.js"
import { TaskProposalStore } from "../src/persistence/proposals/store.js"
import { assertItemEvidence } from "../src/persistence/sqlite/connection-item-evidence.js"
import { connectionItemTools } from "../src/tools/connection-items.js"
import { GoogleConnections } from "../src/google/service.js"
import { migratedTo } from "./fixtures/migrated-to.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { partialService } from "./kit.js"

const AT = "2026-11-20T00:00:00.000Z"

const routedItem = (database: DatabaseSync, id: string, state: "pending" | "routed") =>
  database
    .prepare(
      `INSERT INTO connection_items (item_id, source, account, external_id, thread_key, title,
        sender, received_at, snippet, fetched_at, state, owner_space_id, route_basis, route_reason,
        routed_at, detail)
      VALUES (?, 'gmail', 'me', ?, ?, 'Invoice', 'Ann', ?, 'Pay it', ?, ?, NULL, ?, ?, ?, NULL)`
    )
    .run(
      id,
      `external-${id}`,
      `thread-${id}`,
      AT,
      AT,
      state,
      state === "routed" ? "home" : null,
      state === "routed" ? "No Space fits." : null,
      state === "routed" ? AT : null
    )

it("M2 keeps every item without its route and drops the thread owners and item_move rules", () => {
  const database = migratedTo(185, (database) => {
    routedItem(database, "item-a", "routed")
    routedItem(database, "item-b", "pending")
    database.exec(`INSERT INTO connection_threads (source, account, thread_key, owner_space_id,
        basis, updated_at) VALUES ('gmail', 'me', 'thread-item-a', NULL, 'user', '${AT}')`)
    database.exec(`INSERT INTO permission_rules (rule_id, list_kind, subject_kind, tool_name,
        decision, source_kind, created_at)
      VALUES ('rule-move', 'global', 'tool', 'item_move', 'allow', 'settings', '${AT}'),
        ('rule-read', 'global', 'tool', 'connection_item_read', 'allow', 'settings', '${AT}')`)
  })
  expect(database.prepare("SELECT * FROM connection_items ORDER BY item_id").all()).toEqual(
    ["item-a", "item-b"].map((id) => ({
      item_id: id,
      source: "gmail",
      account: "me",
      external_id: `external-${id}`,
      thread_key: `thread-${id}`,
      title: "Invoice",
      sender: "Ann",
      received_at: AT,
      snippet: "Pay it",
      fetched_at: AT,
      detail: null
    }))
  )
  expect(
    database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'connection_threads%'").all()
  ).toEqual([])
  expect(database.prepare("SELECT rule_id FROM permission_rules").all()).toEqual([
    { rule_id: "rule-read" }
  ])
  database.close()
})

const homeOffer = (
  database: DatabaseSync,
  id: string,
  seq: number,
  status: "offered" | "held" | "rejected"
) =>
  database
    .prepare(
      `INSERT INTO task_proposals (proposal_id, place, dedupe_key, stable_key, text, owner,
        capture_json, sources_json, evidence_revision_key, candidate_hash, revision, seq, status,
        settlement_client_id, settlement_decision, created_at, updated_at, settled_at)
      VALUES (?, 'home', ?, ?, 'Reply to Ann', 'worker', '{"basis":"inferred","reason":"Asked."}',
        '[]', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      `home:${id}`,
      id,
      id,
      id,
      seq,
      status,
      status === "rejected" ? "app" : null,
      status === "rejected" ? "reject" : null,
      AT,
      AT,
      status === "rejected" ? AT : null
    )

it("M2 moves every Home offer to Main and keeps Main within its three open offers", () => {
  const database = migratedTo(185, (database) => {
    const main = String(
      database.prepare("SELECT space_id FROM spaces WHERE kind = 'main'").get()?.space_id
    )
    database
      .prepare(
        `INSERT INTO task_proposals (proposal_id, place, space_id, dedupe_key, stable_key, text,
          owner, capture_json, sources_json, evidence_revision_key, candidate_hash, revision, seq,
          status, created_at, updated_at)
        VALUES ('own', 'space', ?, 'own', 'own', 'Own offer', 'worker',
          '{"basis":"inferred","reason":"Asked."}', '[]', 'own', 'own', 0, 1, 'offered', ?, ?)`
      )
      .run(main, AT, AT)
    homeOffer(database, "skipped", 2, "rejected")
    homeOffer(database, "oldest", 3, "offered")
    homeOffer(database, "older", 4, "held")
    homeOffer(database, "newer", 5, "offered")
    homeOffer(database, "newest", 6, "held")
  })
  const main = database.prepare("SELECT space_id FROM spaces WHERE kind = 'main'").get()?.space_id
  const rows = database
    .prepare(
      `SELECT proposal_id, place, space_id = ? AS in_main, status, settled_at IS NOT NULL AS settled
      FROM task_proposals ORDER BY seq`
    )
    .all(main)
  expect(rows).toEqual([
    { proposal_id: "own", place: "space", in_main: 1, status: "offered", settled: 0 },
    { proposal_id: "skipped", place: "space", in_main: 1, status: "rejected", settled: 1 },
    { proposal_id: "oldest", place: "space", in_main: 1, status: "expired", settled: 1 },
    { proposal_id: "older", place: "space", in_main: 1, status: "expired", settled: 1 },
    { proposal_id: "newer", place: "space", in_main: 1, status: "offered", settled: 0 },
    { proposal_id: "newest", place: "space", in_main: 1, status: "offered", settled: 0 }
  ])
  expect(() =>
    database.exec(
      "UPDATE task_proposals SET place = 'home', space_id = NULL WHERE proposal_id = 'own'"
    )
  ).toThrow(/CHECK constraint failed/u)
  expect(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE tbl_name = 'task_proposals' AND type = 'trigger' ORDER BY name"
      )
      .all()
  ).toEqual([
    { name: "task_proposal_revisions_insert" },
    { name: "task_proposal_revisions_update" }
  ])
  database.close()
})

const mainId = (sql: SqlClient.SqlClient) =>
  sql<{ readonly space_id: string }>`SELECT space_id FROM spaces WHERE kind = 'main'`.pipe(
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
    readonly authoredIn: { readonly session: string; readonly run: string } | undefined
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
        ${run?.run ?? null}, ${run?.session ?? null}, ${run === undefined ? null : "turn-1"},
        ${run === undefined ? null : "call-1"},
        ${run === undefined ? null : '{"origin":"automation","task_item_id":null,"task_generation":null}'},
        0, 1, 'offered', ${AT}, ${AT})`
  })

const chatWithTurn = (
  sql: SqlClient.SqlClient,
  chat: { readonly session: string; readonly run: string; readonly spaceId: string | null }
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
        json_object('turn_id', 'turn-1'), ${`assistant-${chat.run}`})`
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
    const rows = yield* sql<{ readonly space_id: string }>`SELECT space_id FROM space_tasks
      WHERE item_id = ${task?.item_id ?? ""}`
    return rows[0]?.space_id
  })

it("a moved item offer and an Automation's Main offer start on Main or on the Space picked", async () => {
  const placed = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
        VALUES ('work', 'Work', 'work', ${AT}, ${AT})`
      yield* seedItem(sql, "item-1")
      yield* seedItem(sql, "item-2")
      const item = (id: string) =>
        JSON.stringify([{ kind: "connection_item", item_id: id, revision: id }])
      yield* mainOffer(sql, { id: "moved-main", sources: item("item-1"), authoredIn: undefined })
      yield* mainOffer(sql, { id: "moved-work", sources: item("item-2"), authoredIn: undefined })
      yield* chatWithTurn(sql, { session: "automation", run: "automation-run", spaceId: null })
      const turn = JSON.stringify([
        { kind: "chat", session_id: "automation", turn_id: "turn-1", revision: "turn-1" }
      ])
      const authoredIn = { session: "automation", run: "automation-run" }
      yield* mainOffer(sql, { id: "automation-main", sources: turn, authoredIn })
      yield* mainOffer(sql, { id: "automation-work", sources: turn, authoredIn })
      const main = yield* mainId(sql)
      const label = (spaceId: string | undefined) => (spaceId === main ? "main" : spaceId)
      return {
        movedMain: label(yield* start("moved-main")),
        movedWork: label(yield* start("moved-work", "work")),
        automationMain: label(yield* start("automation-main")),
        automationWork: label(yield* start("automation-work", "work"))
      }
    })
  )
  expect(placed).toEqual({
    movedMain: "main",
    movedWork: "work",
    automationMain: "main",
    automationWork: "work"
  })
})

it("a Main chat's offer citing a stored item starts, and item evidence needs only a stored item", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainId(sql)
      yield* seedItem(sql, "item-1")
      yield* chatWithTurn(sql, { session: "main-chat", run: "main-run", spaceId: main })
      yield* mainOffer(sql, {
        id: "main-chat-offer",
        sources: JSON.stringify([
          { kind: "chat", session_id: "main-chat", turn_id: "turn-1", revision: "turn-1" },
          { kind: "connection_item", item_id: "item-1", revision: "item-1" }
        ]),
        authoredIn: { session: "main-chat", run: "main-run" }
      })
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
        started: started === main,
        stored: yield* evidence("item-2"),
        unknown: yield* evidence("item-3")
      }
    })
  )
  expect(outcome).toEqual({
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
      return { saved, items: read.items.map(({ itemId: _itemId, ...item }) => item) }
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

it("the connection item tools are a read of recent items and a read of one; item_move is gone", async () => {
  const tools = await Effect.runPromise(
    connectionItemTools.pipe(
      Effect.provideService(
        ConnectionItemStore,
        partialService<ConnectionItemStore["Service"]>("ConnectionItemStore", {})
      ),
      Effect.provideService(
        GoogleConnections,
        partialService<GoogleConnections["Service"]>("GoogleConnections", {})
      )
    )
  )
  expect(tools.map((tool) => tool.definition.name)).toEqual([
    "connection_items_state",
    "connection_item_read"
  ])
})
