import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { databaseSchema } from "../src/persistence/schema/database.js"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { authorityHistory } from "../src/persistence/migrations/0087_authority_history.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

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

it("records effective grant removal without retaining command arguments", () => {
  const database = opened()
  try {
    database.exec(`INSERT INTO permission_rules
      (rule_id, list_kind, subject_kind, executable_path, argument_prefix_json, decision,
        source_kind, created_at)
      VALUES ('rule', 'global', 'command', '/usr/bin/example', '["secret-token"]', 'allow',
        'settings', '2026-10-16T00:00:00Z')`)
    database.exec("UPDATE permission_rules SET decision = 'never' WHERE rule_id = 'rule'")
    database.exec("DELETE FROM permission_rules WHERE rule_id = 'rule'")
    const change = { permission_kind: "rule", permission_id: "rule", argument_count: 1 }
    expect(
      database
        .prepare(`SELECT permission_kind, permission_id, action, argument_count, previous_mode,
            next_mode FROM permission_changes ORDER BY change_id`)
        .all()
    ).toEqual([
      { ...change, action: "granted", previous_mode: null, next_mode: "allow" },
      { ...change, action: "changed", previous_mode: "allow", next_mode: "never" },
      { ...change, action: "revoked", previous_mode: "never", next_mode: null }
    ])
    expect(
      JSON.stringify(database.prepare("SELECT * FROM permission_changes").all())
    ).not.toContain("secret-token")
  } finally {
    database.close()
  }
})

it("labels preexisting live permissions as a baseline without inventing grant events", () => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of baselineStatements) database.exec(statement)
    database.exec("PRAGMA user_version = 1")
    for (const step of pendingMigrationSteps(
      { kind: "pending", from: 1, bridge: undefined },
      migrations.filter((migration) => migration.version < authorityHistory.version)
    ))
      step.run(database)
    database.exec(`INSERT INTO standing_permissions
      (permission_id, principal, tool_name, granted_at)
      VALUES ('old-grant', 'desk:old', 'example', '2026-10-01T00:00:00Z')`)
    database.exec(`INSERT INTO command_permissions
      (permission_id, executable_path, argument_prefix_json, display_prefix, granted_at)
      VALUES ('old-command', '/usr/bin/example',
        '["a","b","c","d","e","f","g","h","i"]', 'example …', NULL)`)
    database.exec(`UPDATE tool_settings SET overrides_json = '{"example":"ask"}'
      WHERE singleton_id = 1`)

    authorityHistory.up(database)

    expect(
      database
        .prepare(`SELECT permission_kind, permission_id, action, principal, tool_name,
            next_mode, occurred_at FROM permission_changes ORDER BY change_id`)
        .all()
    ).toEqual([
      {
        permission_kind: "standing",
        permission_id: "old-grant",
        action: "baseline",
        principal: "desk:old",
        tool_name: "example",
        next_mode: null,
        occurred_at: "2026-10-01T00:00:00Z"
      },
      {
        permission_kind: "command",
        permission_id: "old-command",
        action: "baseline",
        principal: null,
        tool_name: null,
        next_mode: null,
        occurred_at: null
      },
      {
        permission_kind: "override",
        permission_id: null,
        action: "baseline",
        principal: null,
        tool_name: "example",
        next_mode: "ask",
        occurred_at: null
      }
    ])
  } finally {
    database.close()
  }
})
