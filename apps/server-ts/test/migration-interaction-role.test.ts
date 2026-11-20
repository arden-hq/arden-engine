import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { interactionRole } from "../src/persistence/migrations/0177_interaction_role.js"
import { migrations } from "../src/persistence/migrations/index.js"

const AT = "2026-11-20T00:00:00.000Z"

const migrated = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
  for (const statement of baselineStatements) database.exec(statement)
  for (const migration of migrations.filter((entry) => entry.version < interactionRole.version))
    migration.up(database)
  database.exec("PRAGMA foreign_keys = ON")
  return database
}

const OLD: ReadonlyArray<Record<string, unknown>> = [
  { message_id: "typed", role: "user", content: "Find jobs" },
  {
    message_id: "answer",
    role: "user",
    is_meta: true,
    question_answer: { question_id: "q" },
    content: "Yes"
  },
  {
    message_id: "peer",
    role: "user",
    is_meta: true,
    content: "Check the archive",
    interaction: {
      kind: "message",
      from: { type: "agent", id: "lead", display_name: "Lead" },
      to: { type: "agent", id: "me" },
      content: "Check the archive",
      causedBy: { type: "tool_call", id: "call" }
    }
  },
  {
    message_id: "worker",
    role: "user",
    is_meta: true,
    content: "Found 42 mentors",
    interaction: {
      kind: "message",
      from: { type: "agent", id: "worker" },
      to: { type: "agent", id: "me" },
      content: "Update from the worker:\nFound 42 mentors"
    }
  },
  {
    message_id: "workflow",
    role: "user",
    is_meta: true,
    content: "[1]",
    interaction: {
      kind: "completion",
      outcome: "completed",
      from: { type: "workflow", id: "wf-1" },
      to: { type: "agent", id: "me" },
      content: "[1]"
    }
  },
  {
    message_id: "job",
    role: "user",
    content: "Review",
    automation: { task_id: "auto-1", name: "Weekly", prompt: "Review", context_mode: "fresh" }
  },
  { message_id: "nudge", role: "user", is_meta: true, client_id: "goal:x", content: "Continue" },
  {
    message_id: "card",
    role: "user",
    is_meta: true,
    content: "",
    communication: { kind: "arrival" }
  },
  {
    message_id: "headline:child::i1",
    role: "assistant",
    is_meta: true,
    content: "Woken to continue"
  },
  { message_id: "context", role: "developer", is_meta: true, content: "Local time" }
]

it("migration 0177 gives everything the person did not write the interaction role", () => {
  const database = migrated()
  database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity)
    VALUES ('chat', 'chat-ref', '${AT}', '${AT}')`)
  const insert = database.prepare(`INSERT INTO session_messages
    (session_id, message_id, seq, role, message_json, created_at) VALUES ('chat', ?, ?, ?, ?, '${AT}')`)
  OLD.forEach((message, seq) =>
    insert.run(String(message.message_id), seq, String(message.role), JSON.stringify(message))
  )
  database.exec(`INSERT INTO chat_idempotency_keys (session_id, client_id, request_hash, message_id,
      message_json, status, created_at, updated_at)
    VALUES ('chat', 'queued-peer', 'h', 'queued-peer', '${JSON.stringify({ ...OLD[2], message_id: "queued-peer" })}',
      'accepted', '${AT}', '${AT}')`)

  interactionRole.up(database)

  const rows = Object.fromEntries(
    database
      .prepare("SELECT message_id, role, message_json FROM session_messages ORDER BY seq")
      .all()
      .map((row) => [String(row.message_id), JSON.parse(String(row.message_json))])
  )
  expect(rows.typed).toEqual({ message_id: "typed", role: "user", content: "Find jobs" })
  expect(rows.answer).toEqual({
    message_id: "answer",
    role: "user",
    question_answer: { question_id: "q" },
    content: "Yes"
  })
  expect(rows.peer).toEqual({
    message_id: "peer",
    role: "interaction",
    from: { source: "agent", id: "lead", name: "Lead" },
    to: { source: "agent", id: "me" },
    kind: "message",
    caused_by: { type: "tool_call", id: "call" },
    content: "Check the archive"
  })
  expect(rows.worker).toMatchObject({
    role: "interaction",
    content: "Update from the worker:\nFound 42 mentors",
    preview: "Found 42 mentors"
  })
  expect(rows.workflow).toMatchObject({
    role: "interaction",
    from: { source: "workflow", id: "wf-1" },
    kind: "completion",
    outcome: "completed"
  })
  expect(rows.job).toMatchObject({
    role: "interaction",
    from: { source: "automation", id: "auto-1", name: "Weekly" },
    kind: "assignment",
    automation: { task_id: "auto-1" }
  })
  expect(rows.nudge).toMatchObject({
    role: "interaction",
    from: { source: "harness", id: "goal:x" },
    kind: "event"
  })
  expect(rows.card).toMatchObject({
    role: "interaction",
    from: { source: "harness", id: "communication" }
  })
  expect(rows["headline:child::i1"]).toMatchObject({
    role: "interaction",
    from: { source: "harness", id: "automation_headline" }
  })
  expect(rows.context).toEqual({ message_id: "context", role: "developer", content: "Local time" })
  const columnRoles = database
    .prepare("SELECT role FROM session_messages ORDER BY seq")
    .all()
    .map((row) => row.role)
  expect(columnRoles).toEqual(Object.values(rows).map((message) => message.role))
  expect(
    JSON.parse(
      String(database.prepare("SELECT message_json FROM chat_idempotency_keys").get()?.message_json)
    )
  ).toMatchObject({ role: "interaction", from: { source: "agent", id: "lead" } })
  expect(() =>
    insert.run("bad", 99, "person", JSON.stringify({ message_id: "bad", role: "person" }))
  ).toThrow("Unknown transcript message role")
})
