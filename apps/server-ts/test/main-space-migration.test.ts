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

const session = (
  database: DatabaseSync,
  row: {
    readonly id: string
    readonly type?: "chat" | "channel" | "agent"
    readonly space?: string
    readonly automation?: string
    readonly parent?: string
    readonly archived?: boolean
  }
) =>
  database
    .prepare(
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type,
        space_id, origin_automation_id, parent_session_id, parent_run_id, parent_tool_call_id,
        archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.id,
      AT,
      AT,
      row.type ?? "chat",
      row.space ?? null,
      row.automation ?? null,
      row.parent ?? null,
      row.type === "agent" ? "run" : null,
      row.type === "agent" ? "call" : null,
      row.archived === true ? AT : null
    )

const chatTask = (database: DatabaseSync, id: string, home: string, key: string) =>
  database
    .prepare(
      `INSERT INTO space_tasks (item_id, space_id, home_session_id, stable_key, text, status,
        owner, runs_in, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, 'open', 'worker', 'chat', ?, ?)`
    )
    .run(id, home, key, key, `${AT}-${id}`, AT)

it("M1 adds one Main Space and moves every owner chat and its chat Tasks into it", () => {
  const database = migratedTo(183, (database) => {
    space(database, "work", "Work")
    session(database, { id: "loose" })
    session(database, { id: "loose-agent", type: "agent", parent: "loose" })
    session(database, { id: "loose-old", archived: true })
    session(database, { id: "filed", space: "work" })
    session(database, { id: "automation", type: "channel", automation: "daily" })
    session(database, { id: "automation-run", parent: "automation", automation: "daily" })
    session(database, { id: "review", type: "channel", space: "work", automation: "space:work" })
    chatTask(database, "first", "loose", "reply")
    chatTask(database, "second", "loose-old", "reply")
    chatTask(database, "automation-task", "automation", "reply")
  })
  const main = database.prepare("SELECT space_id, name, kind FROM spaces WHERE kind = 'main'").all()
  expect(main).toMatchObject([{ name: "Main", kind: "main" }])
  const mainId = main[0]?.space_id
  expect(
    database
      .prepare(
        `SELECT session_id, space_id = ? AS in_main, space_id FROM sessions ORDER BY session_id`
      )
      .all(mainId)
      .map((row) => [row.session_id, row.in_main === 1 ? "main" : row.space_id])
  ).toEqual([
    ["automation", null],
    ["automation-run", null],
    ["filed", "work"],
    ["loose", "main"],
    ["loose-agent", "main"],
    ["loose-old", "main"],
    ["review", "work"]
  ])
  expect(
    database
      .prepare(
        `SELECT item_id, space_id = ? AS in_main, stable_key, home_session_id
        FROM space_tasks ORDER BY item_id`
      )
      .all(mainId)
  ).toEqual([
    {
      item_id: "automation-task",
      in_main: null,
      stable_key: "reply",
      home_session_id: "automation"
    },
    { item_id: "first", in_main: 1, stable_key: "reply", home_session_id: "loose" },
    { item_id: "second", in_main: 1, stable_key: "reply-2", home_session_id: "loose-old" }
  ])
  database.close()
})

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
