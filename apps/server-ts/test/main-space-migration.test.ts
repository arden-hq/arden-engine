import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

const AT = "2026-11-20T00:00:00.000Z"

const migratedTo = (version: number, seed: (database: DatabaseSync) => void) => {
  const database = new DatabaseSync(":memory:")
  for (const statement of baselineStatements) database.exec(statement)
  database.exec("PRAGMA user_version = 1")
  for (const step of pendingMigrationSteps(
    { kind: "pending", from: 1, bridge: undefined },
    migrations.filter((migration) => migration.version < version)
  ))
    step.run(database)
  seed(database)
  for (const step of pendingMigrationSteps(
    { kind: "pending", from: version - 1, bridge: undefined },
    migrations
  ))
    step.run(database)
  return database
}

const space = (database: DatabaseSync, id: string, name: string, archived = false) =>
  database
    .prepare(
      `INSERT INTO spaces (space_id, name, name_key, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, name, name.toLowerCase(), AT, AT, archived ? AT : null)

it("M1 names the Main Space so it never takes an active Space's name", () => {
  const database = migratedTo(183, (database) => {
    space(database, "taken", "main")
    space(database, "old", "Main space", true)
  })
  expect(database.prepare("SELECT name, name_key FROM spaces WHERE kind = 'main'").all()).toEqual([
    { name: "Main space", name_key: "main space" }
  ])
  database.close()
})

it("M1 keeps every entity event and lets a post be recorded", () => {
  const database = migratedTo(183, (database) => {
    database.exec(`INSERT INTO entity_events (key, entity, entity_id, event, run_id, text, place,
        place_kind, occurred_at, shown, delivery_error)
      VALUES ('task-done:1', 'task', 'task-1', 'done', 'run-1', 'Done', NULL, 'gone', '${AT}', 1, NULL)`)
  })
  database.exec(`INSERT INTO entity_events (key, entity, entity_id, event, run_id, text, place,
      place_kind, occurred_at, shown, delivery_error)
    VALUES ('post:1', 'automation', 'events', 'posted', NULL, 'Hi', 'chat', 'own', '${AT}', 1, NULL)`)
  expect(database.prepare("SELECT key, event FROM entity_events ORDER BY key").all()).toEqual([
    { key: "post:1", event: "posted" },
    { key: "task-done:1", event: "done" }
  ])
  database.close()
})

const LONG_KEY = "k".repeat(80)

it("M1 moves every owner chat into Main with its chat Tasks, their records and worker channels", () => {
  const database = migratedTo(183, (database) => {
    space(database, "work", "Work")
    database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
        session_type, space_id, origin_automation_id, parent_session_id, parent_run_id,
        parent_tool_call_id, archived_at)
      VALUES ('loose', 'loose', '${AT}', '${AT}', 'chat', NULL, NULL, NULL, NULL, NULL, NULL),
        ('loose-agent', 'loose-agent', '${AT}', '${AT}', 'agent', NULL, NULL, 'loose', 'run', 'call', NULL),
        ('loose-old', 'loose-old', '${AT}', '${AT}', 'chat', NULL, NULL, NULL, NULL, NULL, '${AT}'),
        ('filed', 'filed', '${AT}', '${AT}', 'chat', 'work', NULL, NULL, NULL, NULL, NULL),
        ('automation', 'automation', '${AT}', '${AT}', 'channel', NULL, 'daily', NULL, NULL, NULL, NULL),
        ('automation-run', 'automation-run', '${AT}', '${AT}', 'chat', NULL, 'daily', 'automation', NULL, NULL, NULL),
        ('worker', 'worker', '${AT}', '${AT}', 'channel', NULL, 'task:first', NULL, NULL, NULL, NULL)`)
    database.exec(`INSERT INTO space_tasks (item_id, space_id, home_session_id, stable_key, text,
        status, owner, runs_in, created_at, updated_at)
      VALUES ('first', NULL, 'loose', '${LONG_KEY}', 'Reply', 'open', 'worker', 'chat', '${AT}', '${AT}'),
        ('second', NULL, 'loose-old', '${LONG_KEY}', 'Reply', 'open', 'worker', 'chat', '${AT}', '${AT}'),
        ('automation-task', NULL, 'automation', 'reply', 'Reply', 'open', 'worker', 'chat', '${AT}', '${AT}')`)
    database.exec(`INSERT INTO space_task_comments (space_id, item_id, author, body, created_at)
      VALUES (NULL, 'first', 'user', 'Note', '${AT}')`)
    database.exec(`INSERT INTO space_task_events (space_id, item_id, event_type, summary, created_at)
      VALUES (NULL, 'second', 'created', 'Reply', '${AT}')`)
    database.exec(`INSERT INTO space_task_attachments (space_id, item_id, name, media_type, data,
        size, created_by, created_at)
      VALUES (NULL, 'first', 'a.txt', 'text/plain', X'61', 1, 'user', '${AT}')`)
  })
  const main = database.prepare("SELECT space_id FROM spaces WHERE kind = 'main'").get()?.space_id
  const named = (rows: ReadonlyArray<Record<string, unknown>>) =>
    rows.map((row) => ({ ...row, space_id: row.space_id === main ? "main" : row.space_id }))
  expect(
    named(database.prepare("SELECT session_id, space_id FROM sessions ORDER BY session_id").all())
  ).toEqual([
    { session_id: "automation", space_id: null },
    { session_id: "automation-run", space_id: null },
    { session_id: "filed", space_id: "work" },
    { session_id: "loose", space_id: "main" },
    { session_id: "loose-agent", space_id: "main" },
    { session_id: "loose-old", space_id: "main" },
    { session_id: "worker", space_id: "main" }
  ])
  expect(
    named(
      database
        .prepare("SELECT item_id, space_id, stable_key FROM space_tasks ORDER BY item_id")
        .all()
    )
  ).toEqual([
    { item_id: "automation-task", space_id: null, stable_key: "reply" },
    { item_id: "first", space_id: "main", stable_key: LONG_KEY },
    { item_id: "second", space_id: "main", stable_key: `${"k".repeat(78)}-2` }
  ])
  expect(
    named(
      database
        .prepare(
          `SELECT 'comment' AS kind, space_id FROM space_task_comments
          UNION ALL SELECT 'event', space_id FROM space_task_events
          UNION ALL SELECT 'attachment', space_id FROM space_task_attachments ORDER BY kind`
        )
        .all()
    )
  ).toEqual([
    { kind: "attachment", space_id: "main" },
    { kind: "comment", space_id: "main" },
    { kind: "event", space_id: "main" }
  ])
  database.close()
})

it("M1 keeps every Task key that was already unique and suffixes only the repeats", () => {
  const database = migratedTo(183, (database) => {
    database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity)
      VALUES ('a', 'a', '${AT}', '${AT}'), ('b', 'b', '${AT}', '${AT}'), ('c', 'c', '${AT}', '${AT}')`)
    database.exec(`INSERT INTO space_tasks (item_id, space_id, home_session_id, stable_key, text,
        status, owner, runs_in, created_at, updated_at)
      VALUES ('first', NULL, 'a', 'reply', 'Reply', 'open', 'worker', 'chat', '${AT}', '${AT}'),
        ('second', NULL, 'b', 'reply', 'Reply', 'open', 'worker', 'chat', '${AT}', '${AT}'),
        ('third', NULL, 'c', 'reply-2', 'Reply', 'open', 'worker', 'chat', '${AT}', '${AT}')`)
  })
  expect(
    database.prepare("SELECT item_id, stable_key FROM space_tasks ORDER BY item_id").all()
  ).toEqual([
    { item_id: "first", stable_key: "reply" },
    { item_id: "second", stable_key: "reply-3" },
    { item_id: "third", stable_key: "reply-2" }
  ])
  database.close()
})

it("M1 moves a pre-upgrade run's captured Space and authority into Main with its chat", () => {
  const policy = (session: string) =>
    JSON.stringify({ run_policy: { authority_session_id: session, space: null } })
  const authority = (kind: string) =>
    JSON.stringify({ actor: { kind }, owns: { space_id: null }, memory: { _tag: "None" } })
  const database = migratedTo(183, (database) => {
    database.exec(`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
        session_type, origin_automation_id)
      VALUES ('loose', 'loose', '${AT}', '${AT}', 'chat', NULL),
        ('daily', 'daily', '${AT}', '${AT}', 'channel', 'daily')`)
    const run = database.prepare(`INSERT INTO chat_runs (run_id, session_id, status, started_at,
        updated_at, assistant_message_id, metadata_json, authority_json)
      VALUES (?, ?, 'pending', '${AT}', '${AT}', ?, ?, ?)`)
    run.run("person-run", "loose", "a1", policy("loose"), authority("person"))
    run.run("automation-run", "daily", "a2", policy("daily"), authority("automation"))
  })
  const main = database.prepare("SELECT space_id FROM spaces WHERE kind = 'main'").get()?.space_id
  expect(
    database
      .prepare(
        `SELECT run_id, json_extract(metadata_json, '$.run_policy.space.space_id') AS policy_space,
          json_extract(authority_json, '$.owns.space_id') AS owns_space
        FROM chat_runs ORDER BY run_id`
      )
      .all()
  ).toEqual([
    { run_id: "automation-run", policy_space: null, owns_space: null },
    { run_id: "person-run", policy_space: main, owns_space: main }
  ])
  expect(() =>
    database.exec(`UPDATE chat_runs SET authority_json = '{}' WHERE run_id = 'person-run'`)
  ).toThrow(/Run authority is immutable/)
  database.close()
})
