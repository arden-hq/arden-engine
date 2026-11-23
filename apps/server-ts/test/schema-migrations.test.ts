import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect, Exit } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import {
  BASELINE_VERSION,
  LATEST_SCHEMA_VERSION,
  migrations,
  type Migration
} from "../src/persistence/migrations/index.js"
import {
  MigrationError,
  pendingMigrationSteps,
  planMigrations
} from "../src/persistence/migrations/runner.js"
import {
  buildReferenceSchemaManifest,
  readSchemaManifest,
  schemaIdentity
} from "../src/persistence/schema/manifest.js"
import { migrateAtStartup } from "../src/persistence/sqlite/release-safety.js"
import { releasedMigrationSql } from "./fixtures/migration-sql-pins.js"

const runMigrations = (
  database: DatabaseSync,
  plan: Parameters<typeof pendingMigrationSteps>[0],
  list: ReadonlyArray<Migration> = migrations
): void => {
  try {
    for (const step of pendingMigrationSteps(plan, list)) step.run(database)
  } finally {
    database.exec("PRAGMA foreign_keys = ON")
  }
}

const recording = (database: DatabaseSync, log: string[]): DatabaseSync =>
  new Proxy(database, {
    get: (target, key) => {
      if (key === "exec")
        return (text: string) => {
          log.push(text)
          target.exec(text)
        }
      if (key === "prepare")
        return (text: string) => {
          log.push(text)
          return target.prepare(text)
        }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    }
  })

const digest = (texts: ReadonlyArray<string>): string =>
  createHash("sha256").update(JSON.stringify(texts)).digest("hex")

const renderedMigrationSql = (): Readonly<Record<number, string>> => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of baselineStatements) database.exec(statement)
    database.exec(`PRAGMA user_version = ${BASELINE_VERSION}`)
    const logs = new Map(migrations.map((migration) => [migration.version, [] as string[]]))
    const recorded = migrations.map((migration): Migration => ({
      ...migration,
      up: (target) => migration.up(recording(target, logs.get(migration.version) ?? []))
    }))
    runMigrations(
      database,
      { kind: "pending", from: BASELINE_VERSION, bridge: undefined },
      recorded
    )
    return Object.fromEntries([
      [BASELINE_VERSION, digest(baselineStatements)],
      ...[...logs].map(([version, log]) => [version, digest(log)])
    ])
  } finally {
    database.close()
  }
}

let directory = ""
let filename = ""
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "arden-migrations-"))
  filename = join(directory, "arden.db")
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const withDatabase = <A>(use: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(filename)
  try {
    return use(database)
  } finally {
    database.close()
  }
}

const createBaseline = (version: 0 | 1): void =>
  withDatabase((database) => {
    database.exec("PRAGMA journal_mode = WAL")
    for (const statement of baselineStatements) database.exec(statement)
    database.exec(`PRAGMA user_version = ${version}`)
    database.exec(`INSERT INTO sessions (session_id, public_ref, name, started_at, last_activity)
      VALUES ('kept', 'kept-ref', 'Kept', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z')`)
  })

const snapshot = (database: DatabaseSync) => ({
  version: database.prepare("PRAGMA user_version").get(),
  schema: readSchemaManifest(database),
  sessions: database.prepare("SELECT session_id, name FROM sessions").all()
})

/** The table each `DROP TABLE` in a statement names, with its schema when it gives one. */
const DROPPED_TABLE = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/giu

/**
 * Runs `list` from the baseline and returns each `enforced` migration's drop of a table another
 * table references when the statement runs, as "version table". With foreign keys on, that drop runs each child table's
 * ON DELETE action, so it belongs in a migration that declares `rebuilds`.
 */
const enforcedParentDrops = (list: ReadonlyArray<Migration>): ReadonlyArray<string> => {
  const database = new DatabaseSync(":memory:")
  const referenced = () =>
    new Set(
      database
        .prepare(
          `SELECT DISTINCT lower(f."table") AS parent
           FROM sqlite_schema AS m, pragma_foreign_key_list(m.name) AS f
           WHERE m.type = 'table' AND lower(f."table") <> lower(m.name)`
        )
        .all()
        .map((row) => String(row.parent))
    )
  const offenders: string[] = []
  const watched = list.map((migration): Migration =>
    migration.foreignKeys?.kind !== "enforced"
      ? migration
      : {
          ...migration,
          up: (target) => {
            const check = (text: string) => {
              const parents = referenced()
              for (const [, schema, name] of text.matchAll(DROPPED_TABLE))
                if (schema?.toLowerCase() !== "temp" && parents.has(String(name).toLowerCase()))
                  offenders.push(`${migration.version} ${name}`)
            }
            migration.up(
              new Proxy(target, {
                get: (proxied, key) => {
                  const value: unknown = Reflect.get(proxied, key, proxied)
                  if (typeof value !== "function") return value
                  if (key !== "exec" && key !== "prepare") return value.bind(proxied)
                  return (text: string) => {
                    check(text)
                    return value.call(proxied, text)
                  }
                }
              })
            )
          }
        }
  )
  try {
    for (const statement of baselineStatements) database.exec(statement)
    database.exec(`PRAGMA user_version = ${BASELINE_VERSION}`)
    runMigrations(database, { kind: "pending", from: BASELINE_VERSION, bridge: undefined }, watched)
  } finally {
    database.close()
  }
  return offenders
}

describe("schema migrations", () => {
  it("every migration runs the SQL pinned for it", () => {
    expect(renderedMigrationSql()).toEqual(releasedMigrationSql)
  })

  it("no migration that keeps foreign keys on drops a table another table references", () => {
    const parents: Migration = {
      version: 2,
      name: "adds_parents",
      foreignKeys: { kind: "enforced" },
      up: (database) => {
        database.exec("CREATE TABLE parents (id INTEGER PRIMARY KEY)")
        database.exec(
          "CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id))"
        )
        database.exec("CREATE TABLE leaves (id INTEGER PRIMARY KEY)")
      }
    }
    const drops = (version: number, table: string): Migration => ({
      version,
      name: `drops_${table}`,
      foreignKeys: { kind: "enforced" },
      up: (database) => database.exec(`DROP TABLE IF EXISTS "${table}"`)
    })
    expect(enforcedParentDrops([parents, drops(3, "leaves"), drops(4, "parents")])).toEqual([
      "4 parents"
    ])
    expect(enforcedParentDrops(migrations)).toEqual([])
  })

  it("the baseline plus every migration builds exactly the schema sections declare", () => {
    const database = new DatabaseSync(":memory:")
    try {
      for (const statement of baselineStatements) database.exec(statement)
      database.exec("PRAGMA user_version = 1")
      runMigrations(database, { kind: "pending", from: 1, bridge: undefined })
      const migrated = new Map(
        readSchemaManifest(database).map((row) => [schemaIdentity(row), row])
      )
      const declared = new Map(
        buildReferenceSchemaManifest().map((row) => [schemaIdentity(row), row])
      )
      const differences = [...new Set([...migrated.keys(), ...declared.keys()])]
        .filter((identity) => migrated.get(identity)?.sql !== declared.get(identity)?.sql)
        .map((identity) => ({
          identity,
          migrated: migrated.get(identity)?.sql,
          declared: declared.get(identity)?.sql
        }))
      expect(differences).toEqual([])
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: LATEST_SCHEMA_VERSION
      })
    } finally {
      database.close()
    }
  })

  it("rolls back a failing migration, keeping every earlier one", () => {
    createBaseline(1)
    const fixtures: ReadonlyArray<Migration> = [
      {
        version: 2,
        name: "adds_notes",
        up: (database) => database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)")
      },
      {
        version: 3,
        name: "breaks_midway",
        up: (database) => {
          database.exec("CREATE TABLE doomed (id INTEGER PRIMARY KEY)")
          database.exec("UPDATE sessions SET name = 'Changed'")
          throw new Error("deliberate")
        }
      }
    ]
    const beforeThree = withDatabase((database) => {
      runMigrations(database, { kind: "pending", from: 1, bridge: undefined }, fixtures.slice(0, 1))
      return snapshot(database)
    })

    const failed = withDatabase((database) => {
      const plan = planMigrations(database, fixtures)
      if (plan.kind !== "pending") throw new Error(`unexpected ${plan.kind}`)
      try {
        runMigrations(database, plan, fixtures)
        return undefined
      } catch (cause) {
        return { cause, inTransaction: database.isTransaction, after: snapshot(database) }
      }
    })

    expect(failed?.cause).toBeInstanceOf(MigrationError)
    expect(failed?.cause).toMatchObject({ version: 3 })
    expect(failed?.inTransaction).toBe(false)
    expect(failed?.after).toEqual(beforeThree)
    expect(withDatabase((database) => snapshot(database))).toEqual(beforeThree)
    expect(beforeThree.version).toEqual({ user_version: 2 })
  })

  it("refuses a migration that breaks a reference, however it declares its foreign keys", () => {
    createBaseline(1)
    const parents: Migration = {
      version: 2,
      name: "adds_parents",
      foreignKeys: { kind: "enforced" },
      up: (database) => {
        database.exec("CREATE TABLE parents (id INTEGER PRIMARY KEY)")
        database.exec(
          "CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE)"
        )
        database.exec("INSERT INTO parents (id) VALUES (1), (2)")
        database.exec("INSERT INTO children (id, parent_id) VALUES (10, 1), (20, 2)")
      }
    }
    const dangling: Migration = {
      version: 3,
      name: "writes_dangling",
      foreignKeys: { kind: "enforced" },
      up: (database) => database.exec("INSERT INTO children (id, parent_id) VALUES (30, 99)")
    }
    const wholeDangling: Migration = {
      version: 3,
      name: "writes_dangling_undeclared",
      up: (database) => database.exec("INSERT INTO children (id, parent_id) VALUES (30, 99)")
    }
    const lossyRebuild: Migration = {
      version: 3,
      name: "rebuilds_parents_losing_a_row",
      foreignKeys: { kind: "rebuilds", tables: ["parents"] },
      up: (database) => {
        database.exec("CREATE TABLE parents_next (id INTEGER PRIMARY KEY)")
        database.exec("INSERT INTO parents_next (id) SELECT id FROM parents WHERE id = 1")
        database.exec("DROP TABLE parents")
        database.exec("ALTER TABLE parents_next RENAME TO parents")
      }
    }
    const run = (list: ReadonlyArray<Migration>) =>
      withDatabase((database) => {
        const plan = planMigrations(database, list)
        if (plan.kind !== "pending") throw new Error(`unexpected ${plan.kind}`)
        try {
          runMigrations(database, plan, list)
          return undefined
        } catch (cause) {
          return cause
        }
      })
    const children = () =>
      withDatabase((database) => database.prepare("SELECT id FROM children ORDER BY id").all())

    expect(run([parents])).toBeUndefined()
    expect(run([parents, dangling])).toBeInstanceOf(MigrationError)
    expect(run([parents, wholeDangling])).toBeInstanceOf(MigrationError)
    expect(run([parents, lossyRebuild])).toMatchObject({ version: 3 })
    expect(children()).toEqual([{ id: 10 }, { id: 20 }])
    expect(withDatabase((database) => database.prepare("PRAGMA user_version").get())).toEqual({
      user_version: 2
    })
  })

  it("refuses a database a newer build wrote, untouched", async () => {
    createBaseline(1)
    withDatabase((database) => database.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`))
    const before = withDatabase((database) => snapshot(database))

    const result = await Effect.runPromiseExit(migrateAtStartup(filename))

    expect(Exit.isFailure(result)).toBe(true)
    expect(withDatabase((database) => snapshot(database))).toEqual(before)
  })

  it("never migrates while another connection has the database open", async () => {
    createBaseline(0)
    const other = new DatabaseSync(filename)
    other.prepare("SELECT count(*) FROM sessions").get()
    try {
      const result = await Effect.runPromiseExit(migrateAtStartup(filename))
      expect(Exit.isFailure(result)).toBe(true)
    } finally {
      other.close()
    }
    expect(withDatabase((database) => planMigrations(database))).toMatchObject({ from: 0 })
  })
})
