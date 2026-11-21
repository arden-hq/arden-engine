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
