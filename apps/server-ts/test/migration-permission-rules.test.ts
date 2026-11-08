import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { permissionRules } from "../src/persistence/migrations/0125_permission_rules.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

const at = "2026-10-30T00:00:00.000Z"

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})

const beforeRules = (options: { readonly commandSettings: string }): DatabaseSync => {
  const database = new DatabaseSync(":memory:")
  opened.push(database)
  for (const statement of baselineStatements) database.exec(statement)
  database.exec("PRAGMA user_version = 1")
  for (const step of pendingMigrationSteps(
    { kind: "pending", from: 1, bridge: undefined },
    migrations.filter((migration) => migration.version < permissionRules.version)
  ))
    step.run(database)
  database.exec(`INSERT INTO desks (desk_id, name, name_key, created_at, updated_at, archived_at)
    VALUES ('lab', 'Lab', 'lab', '${at}', '${at}', NULL),
      ('old', 'Old', 'old', '${at}', '${at}', '${at}')`)
  database.exec(`INSERT INTO mcp_servers (name, enabled, transport_json, updated_at)
    VALUES ('runpod', 1, '{}', '${at}'), ('runpod_x', 1, '{}', '${at}')`)
  database.exec(
    `UPDATE tool_settings SET overrides_json = '${JSON.stringify({
      session_send_message: "approve",
      web_fetch: "ask",
      exec_command: "deny",
      bash: "approve",
      "mcp__runpod__delete-pod": "ask",
      mcp__runpod_x__list: "approve",
      mcp__gone__list: "approve"
    })}' WHERE singleton_id = 1`
  )
  const grant = database.prepare(`INSERT INTO standing_permissions
    (permission_id, principal, server_name, tool_name, granted_at) VALUES (?, ?, ?, ?, '${at}')`)
  grant.run("lab-create", "desk:lab", "runpod", "mcp__runpod__create-pod")
  grant.run("lab-delete", "desk:lab", "runpod", "mcp__runpod__delete-pod")
  grant.run("archived", "desk:old", null, "browser_act")
  grant.run("one-chat", "chat:c1", null, "browser_act")
  grant.run("one-automation", "automation:a1", null, "email_update")
  database.exec(`INSERT INTO command_permissions
    (permission_id, executable_path, argument_prefix_json, display_prefix, granted_at)
    VALUES ('gh-status', '/opt/homebrew/bin/gh', '["auth","status"]', 'gh auth status …', '${at}'),
      ('sleep', '/bin/sleep', '[]', 'sleep …', NULL)`)
  database.exec(`INSERT INTO monitor_state (namespace, state, updated_at)
    VALUES ('command_settings', '${options.commandSettings}', '${at}')`)
  return database
}

const migrate = (database: DatabaseSync): void => {
  for (const step of pendingMigrationSteps(
    { kind: "pending", from: permissionRules.version - 1, bridge: undefined },
    migrations.filter((migration) => migration.version <= permissionRules.version)
  ))
    step.run(database)
}

const rules = (database: DatabaseSync) =>
  database
    .prepare(`SELECT list_kind, desk_id, subject_kind, tool_name, server_name, executable_path,
        argument_prefix_json, decision, source_kind, created_at
      FROM permission_rules
      ORDER BY list_kind, subject_kind, tool_name, executable_path`)
    .all()

const rule = {
  list_kind: "global",
  desk_id: null,
  tool_name: null,
  server_name: null,
  executable_path: null,
  argument_prefix_json: null,
  source_kind: "migrated"
}

it("migration 125 keeps each old permission as one rule with the same effect, and drops the rest", () => {
  const database = beforeRules({ commandSettings: '{"host_always_ask":true}' })
  migrate(database)
  expect(rules(database)).toEqual([
    {
      ...rule,
      subject_kind: "command",
      executable_path: "/bin/sleep",
      argument_prefix_json: "[]",
      decision: "allow",
      created_at: null
    },
    {
      ...rule,
      subject_kind: "command",
      executable_path: "/opt/homebrew/bin/gh",
      argument_prefix_json: '["auth","status"]',
      decision: "allow",
      created_at: at
    },
    { ...rule, subject_kind: "host_commands", decision: "ask", created_at: expect.any(String) },
    {
      ...rule,
      subject_kind: "tool",
      tool_name: "exec_command",
      decision: "never",
      created_at: expect.any(String)
    },
    {
      ...rule,
      subject_kind: "tool",
      tool_name: "mcp__runpod__delete-pod",
      server_name: "runpod",
      decision: "ask",
      created_at: expect.any(String)
    },
    {
      ...rule,
      subject_kind: "tool",
      tool_name: "mcp__runpod_x__list",
      server_name: "runpod_x",
      decision: "allow",
      created_at: expect.any(String)
    },
    {
      ...rule,
      subject_kind: "tool",
      tool_name: "session_send_message",
      decision: "allow",
      created_at: expect.any(String)
    },
    {
      ...rule,
      subject_kind: "tool",
      tool_name: "web_fetch",
      decision: "ask",
      created_at: expect.any(String)
    },
    {
      ...rule,
      list_kind: "space",
      desk_id: "lab",
      subject_kind: "tool",
      tool_name: "mcp__runpod__create-pod",
      server_name: "runpod",
      decision: "allow",
      created_at: at
    }
  ])
})

it("migration 125 retires the old stores and keeps permission history readable", () => {
  const database = beforeRules({ commandSettings: '{"host_always_ask":false}' })
  const history = database.prepare("SELECT * FROM permission_changes ORDER BY change_id").all()
  migrate(database)
  const tables = database
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name IN ('tool_settings', 'standing_permissions', 'command_permissions')`)
    .all()
  expect(tables).toEqual([])
  expect(
    database
      .prepare("SELECT namespace FROM monitor_state WHERE namespace = 'command_settings'")
      .all()
  ).toEqual([])
  expect(
    database
      .prepare("SELECT rule_id FROM permission_rules WHERE subject_kind = 'host_commands'")
      .all()
  ).toEqual([])
  const after = database.prepare("SELECT * FROM permission_changes ORDER BY change_id").all()
  expect(after.slice(0, history.length)).toEqual(
    history.map((row) => ({ ...row, subject_kind: null }))
  )
  expect(after.slice(history.length).map((row) => [row["permission_kind"], row["action"]])).toEqual(
    rules(database).map(() => ["rule", "granted"])
  )
})

it.each(["{not json", "[]", '{"host_always_ask":"no"}', '{"host_always_ask":false,"extra":1}'])(
  "migration 125 turns the unreadable command settings %s into the host ask rule",
  (commandSettings) => {
    const database = beforeRules({ commandSettings })
    migrate(database)
    expect(
      database
        .prepare(
          "SELECT list_kind, decision FROM permission_rules WHERE subject_kind = 'host_commands'"
        )
        .all()
    ).toEqual([{ list_kind: "global", decision: "ask" }])
  }
)
