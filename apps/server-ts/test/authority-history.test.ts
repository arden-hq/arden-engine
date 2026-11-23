import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { databaseSchema } from "../src/persistence/schema/database.js"

const opened = () => {
  const database = new DatabaseSync(":memory:")
  database.exec("PRAGMA foreign_keys = ON")
  for (const statement of databaseSchema.statements) database.exec(statement)
  return database
}

it("keeps compact question and approval decisions after the current rows change or disappear", () => {
  const database = opened()
  try {
    database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity)
      VALUES ('chat', 'chat-ref', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z')`)
    database.exec(`INSERT INTO chat_runs
      (run_id, session_id, status, started_at, updated_at, assistant_message_id)
      VALUES ('run', 'chat', 'running', '2026-10-16T00:00:00Z',
        '2026-10-16T00:00:00Z', 'reply')`)
    database.exec(`INSERT INTO tool_calls
      (run_id, session_id, tool_call_id, tool_name, arguments_json, changes_state, status, started_at)
      VALUES ('run', 'chat', 'call', 'example', '{}', 0, 'running', '2026-10-16T00:00:00Z')`)
    database.exec(`INSERT INTO tool_approvals
      (run_id, session_id, tool_call_id, tool_name, action, scope, status, requested_at)
      VALUES ('run', 'chat', 'call', 'example', 'act', 'scope', 'pending', '2026-10-16T00:00:00Z')`)
    database.exec(`UPDATE tool_approvals SET status = 'approved',
      resolved_at = '2026-10-16T00:00:01Z', resolution_json = '{"approved":true,"edited_arguments":{"secret":"token"}}'
      WHERE run_id = 'run' AND tool_call_id = 'call'`)
    database.exec(`UPDATE tool_approvals SET status = 'pending', resolved_at = NULL,
      resolution_json = NULL
      WHERE run_id = 'run' AND tool_call_id = 'call'`)
    database.exec(`UPDATE tool_approvals SET status = 'approved',
      resolved_at = '2026-10-16T00:00:01Z', resolution_json = '{"approved":true}'
      WHERE run_id = 'run' AND tool_call_id = 'call'`)
    database.exec("DELETE FROM tool_approvals WHERE run_id = 'run' AND tool_call_id = 'call'")
    database.exec(`INSERT INTO run_questions (question_id, run_id, tool_call_id, content, created_at)
      VALUES ('question', 'run', 'ask', '{"prompt":"Secret question"}', '2026-10-16T00:00:00Z')`)
    database.exec(`UPDATE run_questions SET resolution =
      '{"client_id":"answer","answer":{"kind":"text","text":"secret answer"},"resolved_at":"2026-10-16T00:00:03Z"}'
      WHERE question_id = 'question'`)
    database.exec("DELETE FROM run_questions WHERE question_id = 'question'")
    database.exec(`INSERT INTO run_questions (question_id, run_id, tool_call_id, content, created_at)
      VALUES ('several', 'run', 'ask-several', '{"prompt":"Pick"}', '2026-10-16T00:00:00Z')`)
    database.exec(`UPDATE run_questions SET resolution =
      '{"client_id":"many","answer":{"kind":"choices","choice_ids":["first","second"],"text":"secret answer"},"resolved_at":"2026-10-16T00:00:04Z"}'
      WHERE question_id = 'several'`)
    database.exec("DELETE FROM run_questions WHERE question_id = 'several'")

    expect(
      database
        .prepare("SELECT kind, status, requested_at, resolved_at FROM tool_approval_decisions")
        .all()
    ).toEqual([
      {
        kind: "resolved",
        status: "approved",
        requested_at: "2026-10-16T00:00:00Z",
        resolved_at: "2026-10-16T00:00:01Z"
      },
      {
        kind: "resolved",
        status: "approved",
        requested_at: "2026-10-16T00:00:00Z",
        resolved_at: "2026-10-16T00:00:01Z"
      }
    ])
    expect(
      database
        .prepare("SELECT kind, answer_kind, choice_id, choice_ids_json FROM question_decisions")
        .all()
    ).toEqual([
      { kind: "answered", answer_kind: "text", choice_id: null, choice_ids_json: null },
      {
        kind: "answered",
        answer_kind: "choices",
        choice_id: null,
        choice_ids_json: '["first","second"]'
      }
    ])
    expect(
      JSON.stringify(database.prepare("SELECT * FROM question_decisions").all())
    ).not.toContain("secret answer")
    expect(
      JSON.stringify(database.prepare("SELECT * FROM tool_approval_decisions").all())
    ).not.toContain("secret")
  } finally {
    database.close()
  }
})
