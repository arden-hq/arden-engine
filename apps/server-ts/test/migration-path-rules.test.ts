import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { migrations } from "../src/persistence/migrations/index.js"
import { pathRules } from "../src/persistence/migrations/0130_path_rules.js"
import { noDefaultFolders } from "../src/persistence/migrations/0132_no_default_folders.js"
import { compiledRules } from "../src/persistence/migrations/0133_compiled_rules.js"
import { pendingMigrationSteps } from "../src/persistence/migrations/runner.js"

const at = "2026-11-01T00:00:00.000Z"

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

it("turns each open Space's folders into change rules, keeps the first where work starts and revokes nothing", () => {
  const database = new DatabaseSync(":memory:")
  opened.push(database)
  for (const statement of baselineStatements) database.exec(statement)
  database.exec("PRAGMA user_version = 1")
  upTo(database, 1, pathRules.version - 1)
  const site = realpathSync(mkdtempSync(path.join(tmpdir(), "arden-path-rules-")))
  const docs = path.join(site, "docs")
  database.exec(`INSERT INTO desks (desk_id, name, name_key, default_cwds, created_at, updated_at, archived_at)
    VALUES ('jobs', 'Jobs', 'jobs', '${JSON.stringify([site, docs])}', '${at}', '${at}', NULL),
      ('empty', 'Empty', 'empty', '[]', '${at}', '${at}', NULL),
      ('old', 'Old', 'old', '${JSON.stringify([site])}', '${at}', '${at}', '${at}')`)
  const generations = () =>
    database.prepare("SELECT desk_id, policy_generation FROM desks ORDER BY desk_id").all()
  const before = generations()

  upTo(database, pathRules.version - 1, pathRules.version)

  expect(
    database
      .prepare(`SELECT list_kind, desk_id, subject_kind, path, access, decision, source_kind
        FROM permission_rules ORDER BY path`)
      .all()
  ).toEqual(
    [site, docs].sort().map((folder) => ({
      list_kind: "space",
      desk_id: "jobs",
      subject_kind: "path",
      path: folder,
      access: "change",
      decision: "allow",
      source_kind: "migrated"
    }))
  )
  expect(
    database.prepare("SELECT desk_id, default_cwds FROM desks ORDER BY desk_id").all()
  ).toEqual([
    { desk_id: "empty", default_cwds: "[]" },
    { desk_id: "jobs", default_cwds: JSON.stringify([site]) },
    { desk_id: "old", default_cwds: JSON.stringify([site]) }
  ])
  expect(generations()).toEqual(before)
  database.exec("UPDATE desks SET default_cwds = '[]' WHERE desk_id = 'jobs'")
  expect(generations()).not.toEqual(before)
})

it("drops each Space's own folder and each chat's, keeping the folder rules and their history", () => {
  const database = new DatabaseSync(":memory:")
  opened.push(database)
  for (const statement of baselineStatements) database.exec(statement)
  database.exec("PRAGMA user_version = 1")
  upTo(database, 1, noDefaultFolders.version - 1)
  const site = realpathSync(mkdtempSync(path.join(tmpdir(), "arden-no-default-")))
  database.exec(`INSERT INTO desks (desk_id, name, name_key, default_cwds, created_at, updated_at, archived_at)
    VALUES ('jobs', 'Jobs', 'jobs', '${JSON.stringify([site])}', '${at}', '${at}', NULL)`)
  database.exec(`INSERT INTO permission_rules (rule_id, list_kind, desk_id, subject_kind, path, access, decision, source_kind)
    VALUES ('r1', 'space', 'jobs', 'path', '${site}', 'change', 'allow', 'migrated')`)
  const generation = database.prepare("SELECT policy_generation FROM desks").get()

  upTo(database, noDefaultFolders.version - 1, noDefaultFolders.version)

  const columns = database
    .prepare("PRAGMA table_info(desks)")
    .all()
    .map((column) => column["name"])
  expect(columns).not.toContain("default_cwds")
  expect(database.prepare("SELECT rule_id, path FROM permission_rules").all()).toEqual([
    { rule_id: "r1", path: site }
  ])
  expect(database.prepare("SELECT policy_generation FROM desks").get()).toEqual(generation)
  database.exec(
    "UPDATE desks SET name = 'Job search', name_key = 'job search' WHERE desk_id = 'jobs'"
  )
  expect(
    database.prepare("SELECT COUNT(*) AS n FROM desk_revisions WHERE desk_id = 'jobs'").get()
  ).toMatchObject({ n: expect.any(Number) })
  database.exec(`UPDATE desks SET archived_at = '${at}' WHERE desk_id = 'jobs'`)
  expect(database.prepare("SELECT policy_generation FROM desks").get()).not.toEqual(generation)
})

it("turns each rule's words into a words rule its hard rule belongs to", () => {
  const database = new DatabaseSync(":memory:")
  opened.push(database)
  for (const statement of baselineStatements) database.exec(statement)
  database.exec("PRAGMA user_version = 1")
  upTo(database, 1, compiledRules.version - 1)
  database.exec(`INSERT INTO permission_rules (rule_id, list_kind, subject_kind, path, access, decision, source_kind, said)
    VALUES ('r1', 'global', 'path', '/Users/me/Documents', 'read', 'never', 'settings', 'never touch Documents')`)

  upTo(database, compiledRules.version - 1, compiledRules.version)

  const rows = database
    .prepare(
      "SELECT rule_id, subject_kind, words, decision, from_rule_id FROM permission_rules ORDER BY subject_kind"
    )
    .all()
  expect(rows).toEqual([
    {
      rule_id: "r1",
      subject_kind: "path",
      words: null,
      decision: "never",
      from_rule_id: "words-r1"
    },
    {
      rule_id: "words-r1",
      subject_kind: "words",
      words: "never touch Documents",
      decision: "never",
      from_rule_id: null
    }
  ])
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("DELETE FROM permission_rules WHERE rule_id = 'words-r1'")
  expect(database.prepare("SELECT COUNT(*) AS n FROM permission_rules").get()).toEqual({ n: 0 })
})
