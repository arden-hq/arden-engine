import { DatabaseSync } from "node:sqlite"
import { baselineStatements } from "../../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../../src/persistence/migrations/index.js"
import { pendingMigrationSteps } from "../../src/persistence/migrations/runner.js"

export const migratedTo = (version: number, seed: (database: DatabaseSync) => void) => {
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
