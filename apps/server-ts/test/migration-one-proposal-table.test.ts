import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { oneProposalTable } from "../src/persistence/migrations/0048_one_proposal_table.js"
import { migrations } from "../src/persistence/migrations/index.js"

const at = (minute: number) => `2026-10-01T00:0${minute}:00.000Z`

it("migration 0048 moves Desk proposals and Home offers into one table", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations.filter((entry) => entry.version < oneProposalTable.version))
    migration.up(database)
  database.exec(`INSERT INTO desks (desk_id, name, name_key, created_at, updated_at)
    VALUES ('desk', 'Desk', 'desk', '${at(0)}', '${at(0)}')`)
  database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity)
    VALUES ('chat', 'chat-ref', '${at(0)}', '${at(0)}')`)
  for (const task of ["task-desk", "task-home"])
    database.exec(`INSERT INTO desk_tasks (item_id, desk_id, stable_key, text, status, owner,
        created_at, updated_at)
      VALUES ('${task}', 'desk', '${task}', 'Task', 'open', 'worker', '${at(0)}', '${at(0)}')`)
  database.exec(`INSERT INTO connection_items (item_id, source, account, external_id, thread_key,
      title, sender, received_at, snippet, fetched_at, state, owner_desk_id, route_basis,
      route_reason, routed_at)
    VALUES ('item', 'gmail', 'me', 'm-1', 't-1', 'Invoice', 'Ann', '${at(0)}', '', '${at(0)}',
      'routed', 'desk', 'router', 'Fits.', '${at(0)}')`)
  const proposal = database.prepare(`INSERT INTO desk_task_proposals (proposal_id, dedupe_key,
      desk_id, stable_key, text, owner, capture_json, sources_json, evidence_revision_key,
      candidate_hash, source_run_id, source_session_id, source_turn_id, source_tool_call_id,
      capture_policy_json, revision, status, item_id, settlement_client_id, settlement_decision,
      settlement_task_json, created_at, updated_at, settled_at)
    VALUES (?, ?, 'desk', ?, 'Pay it', 'worker', '{"basis":"inferred","reason":"Due."}', ?, 'e',
      'c', 'run', 'chat', 'turn', 'call', '{}', 2, ?, ?, ?, ?, ?, ?, ?, ?)`)
  proposal.run(
    "proposal-open",
    "d-1",
    "pay",
    '[{"kind":"connection_item","item_id":"item","revision":"item"}]',
    "offered",
    null,
    null,
    null,
    null,
    at(3),
    at(3),
    null
  )
  proposal.run(
    "proposal-started",
    "d-2",
    "plan",
    "[]",
    "accepted",
    "task-desk",
    "c-1",
    "accept",
    "{}",
    at(1),
    at(1),
    at(1)
  )
  const offer = database.prepare(`INSERT INTO home_offers (offer_id, item_id, source, account,
      thread_key, text, why, item_title, item_from, status, revision, task_item_id,
      settlement_client_id, settlement_decision, created_at, updated_at, settled_at, seq)
    VALUES (?, ?, 'github', 'me', ?, 'Review it', ?, 'PR 7', NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
  offer.run(
    "offer_A",
    null,
    "repo#7",
    "",
    "rejected",
    null,
    "c-2",
    "reject",
    at(2),
    at(2),
    at(2),
    1
  )
  offer.run(
    "offer_B",
    null,
    "repo#8",
    "Asked for review.",
    "accepted",
    "task-home",
    "c-3",
    "accept",
    at(4),
    at(4),
    at(4),
    2
  )
  offer.run("offer_C", null, "repo#9", "Later.", "held", null, null, null, at(5), at(5), null, 3)

  database.exec("PRAGMA foreign_keys = ON")
  oneProposalTable.up(database)

  const rows = database
    .prepare(
      `SELECT proposal_id, place, desk_id, seq, status, item_id, stable_key,
        json_extract(capture_json, '$.reason') AS reason, sources_json, signal_json,
        source_run_id FROM task_proposals ORDER BY seq`
    )
    .all()
  expect(rows).toEqual([
    expect.objectContaining({
      proposal_id: "proposal-started",
      place: "desk",
      seq: 1,
      item_id: "task-desk",
      signal_json: null
    }),
    expect.objectContaining({
      proposal_id: "offer_A",
      place: "home",
      desk_id: null,
      seq: 2,
      status: "rejected",
      reason: "It came in from GitHub.",
      sources_json: "[]",
      source_run_id: null
    }),
    expect.objectContaining({
      proposal_id: "proposal-open",
      place: "desk",
      desk_id: "desk",
      seq: 3,
      source_run_id: "run"
    }),
    expect.objectContaining({
      proposal_id: "offer_B",
      seq: 4,
      status: "accepted",
      item_id: "task-home",
      stable_key: "offer-b",
      reason: "Asked for review."
    }),
    expect.objectContaining({ proposal_id: "offer_C", seq: 5, status: "held", item_id: null })
  ])
  expect(JSON.parse(String(rows[2]?.["signal_json"]))).toEqual({
    source: "gmail",
    account: "me",
    thread_key: "t-1",
    title: "Invoice",
    from: "Ann"
  })
  expect(JSON.parse(String(rows[1]?.["signal_json"]))).toMatchObject({
    source: "github",
    thread_key: "repo#7",
    title: "PR 7"
  })
  expect(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('desk_task_proposals', 'home_offers')"
      )
      .all()
  ).toEqual([])
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([])
  database.close()
})
