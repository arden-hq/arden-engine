import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { dropDiscussions } from "../src/persistence/migrations/0036_drop_discussions.js"
import { migrations } from "../src/persistence/migrations/index.js"

const AT = "2026-09-20T00:00:00.000Z"

const migrated = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations.filter((entry) => entry.version < dropDiscussions.version))
    migration.up(database)
  database.exec("PRAGMA foreign_keys = ON")
  return database
}

it("migration 0036 keeps each discussion's brief as its chat's thread and drops the tables", () => {
  const database = migrated()
  const brief = {
    purpose: "Compare the two runners",
    starts_with: ["Runner A is faster"],
    source_session_id: "source",
    source_turn_id: "turn-1"
  }
  const existingThread = {
    source_session_id: "other",
    source_turn_id: "turn-9",
    purpose: "Moved thread",
    starts_with: []
  }
  database.exec(`INSERT INTO desks (desk_id, name, name_key, created_at, updated_at)
    VALUES ('desk', 'Lab', 'lab', '${AT}', '${AT}')`)
  const session = database.prepare(`INSERT INTO sessions (session_id, public_ref, started_at,
      last_activity, desk_id, metadata) VALUES (?, ?, '${AT}', '${AT}', 'desk', ?)`)
  session.run("source", "source-ref", null)
  session.run("talk", "talk-ref", JSON.stringify({ discussion_context: brief, kept: true }))
  session.run(
    "threaded",
    "threaded-ref",
    JSON.stringify({ discussion_context: brief, thread: existingThread })
  )
  database.exec(`INSERT INTO chat_runs (run_id, session_id, status, stop_reason, started_at,
      updated_at, ended_at, metadata_json, assistant_message_id)
    VALUES ('run', 'source', 'completed', 'end_turn', '${AT}', '${AT}', '${AT}', '{}', 'a-1')`)
  const offer = database.prepare(`INSERT INTO discussion_offers (offer_id, source_session_id,
      source_turn_id, source_run_id, tool_call_id, desk_id, proposal_json, state,
      result_session_id, created_at)
    VALUES (?, 'source', 'turn-1', 'run', ?, 'desk', '{}', ?, ?, '${AT}')`)
  offer.run("offer-talk", "call-1", "accepted", "talk")
  offer.run("offer-threaded", "call-2", "accepted", "threaded")
  offer.run("offer-open", "call-3", "offered", null)
  const discussion = database.prepare(`INSERT INTO session_discussions (session_id, offer_id,
      source_session_id, source_turn_id, purpose, context_json)
    VALUES (?, ?, 'source', 'turn-1', 'Compare the two runners', '["Runner A is faster"]')`)
  discussion.run("talk", "offer-talk")
  discussion.run("threaded", "offer-threaded")
  const delivery = database.prepare(`INSERT INTO automation_deliveries (delivery_id, subject, body,
      payload, status, created_at, destinations) VALUES (?, 's', 'b', ?, ?, '${AT}', '[]')`)
  delivery.run("a".repeat(64), JSON.stringify({ kind: "discussion_finding" }), "pending")
  delivery.run("b".repeat(64), JSON.stringify({ kind: "discussion_finding" }), "delivered")
  delivery.run("c".repeat(64), JSON.stringify({ kind: "result" }), "pending")

  dropDiscussions.up(database)

  const metadata = (id: string): unknown => {
    const row = database.prepare("SELECT metadata FROM sessions WHERE session_id = ?").get(id)
    return row?.metadata === null ? null : JSON.parse(String(row?.metadata))
  }
  expect({
    talk: metadata("talk"),
    threaded: metadata("threaded"),
    source: metadata("source"),
    deliveries: database
      .prepare("SELECT status FROM automation_deliveries ORDER BY delivery_id")
      .all()
      .map((row) => row.status),
    tables: database
      .prepare(
        `SELECT name FROM sqlite_schema
        WHERE name IN ('discussion_offers', 'session_discussions')`
      )
      .all(),
    broken: database.prepare("PRAGMA foreign_key_check").all().length
  }).toEqual({
    talk: {
      kept: true,
      thread: {
        source_session_id: "source",
        source_turn_id: "turn-1",
        purpose: "Compare the two runners",
        starts_with: ["Runner A is faster"],
        source_session_ref: "source-ref"
      }
    },
    threaded: { thread: existingThread },
    source: null,
    deliveries: ["discarded", "delivered", "pending"],
    tables: [],
    broken: 0
  })
})
