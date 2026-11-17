import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { vaultKeyRules } from "../src/persistence/migrations/0170_vault_key_rules.js"
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

it("keeps every rule and its history, and takes a rule about one saved key", () => {
  const database = new DatabaseSync(":memory:")
  opened.push(database)
  for (const statement of baselineStatements) database.exec(statement)
  database.exec("PRAGMA user_version = 1")
  upTo(database, 1, vaultKeyRules.version - 1)
  database.exec(`INSERT INTO permission_rules (rule_id, list_kind, subject_kind, words, decision,
      source_kind, created_at)
    VALUES ('words-1', 'global', 'words', 'archive old newsletters', 'allow', 'settings', 'now')`)
  const rows = () =>
    database
      .prepare(
        "SELECT rule_id, subject_kind, words, key_name, decision FROM permission_rules ORDER BY rule_id"
      )
      .all()

  upTo(database, vaultKeyRules.version - 1, vaultKeyRules.version)

  expect(rows()).toEqual([
    {
      rule_id: "words-1",
      subject_kind: "words",
      words: "archive old newsletters",
      key_name: null,
      decision: "allow"
    }
  ])
  database.exec(`INSERT INTO permission_rules (rule_id, list_kind, subject_kind, key_name, decision,
      source_kind, created_at)
    VALUES ('key-1', 'global', 'vault_key', 'Todoist', 'allow', 'settings', 'now')`)
  expect(() =>
    database.exec(`INSERT INTO permission_rules (rule_id, list_kind, subject_kind, decision, source_kind)
      VALUES ('key-2', 'global', 'vault_key', 'allow', 'settings')`)
  ).toThrow()
  expect(
    database
      .prepare(
        "SELECT permission_id, subject_kind FROM permission_changes WHERE permission_id = 'key-1'"
      )
      .all()
  ).toEqual([{ permission_id: "key-1", subject_kind: "vault_key" }])
})
