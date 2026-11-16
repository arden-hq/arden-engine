import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { modelServerEndpoint } from "../src/persistence/migrations/0170_model_server_endpoint.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})

const upTo = (database: DatabaseSync, from: number, last: number) => {
  for (const step of pendingMigrationSteps(
    { kind: "pending", from, bridge: undefined },
    migrations.filter((migration) => migration.version > from && migration.version <= last)
  ))
    step.run(database)
}

it("gives the saved model endpoint settings an empty list of model servers, keeping the rest", () => {
  const database = new DatabaseSync(":memory:")
  opened.push(database)
  for (const statement of baselineStatements) database.exec(statement)
  database.exec("PRAGMA user_version = 1")
  upTo(database, 1, modelServerEndpoint.version - 1)
  const before = { search: null, decision: null, decisionSource: "endpoint" }
  database
    .prepare("INSERT INTO monitor_state (namespace, state, updated_at) VALUES (?, ?, ?)")
    .run("model_endpoint_settings", JSON.stringify(before), "2026-11-16T00:00:00.000Z")

  upTo(database, modelServerEndpoint.version - 1, modelServerEndpoint.version)

  const row = database
    .prepare("SELECT state FROM monitor_state WHERE namespace = 'model_endpoint_settings'")
    .get()
  expect(JSON.parse(String(row?.["state"]))).toEqual({ ...before, chat: [] })
})
