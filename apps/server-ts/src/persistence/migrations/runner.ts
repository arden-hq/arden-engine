import { DatabaseSync } from "node:sqlite"
import { errorMessage } from "@arden-hq/std/errors"
import {
  classifySchemaManifest,
  manifestOf,
  readForeignTableReferences,
  readSchemaManifest
} from "../schema/manifest.js"
import {
  applySchemaTransitions,
  findSchemaTransition,
  type SchemaTransitionPath
} from "../schema/transitions.js"
import { baselineStatements } from "./0001_baseline.js"
import {
  BASELINE_VERSION,
  checkMigrationOrder,
  migrations,
  type Migration,
  type MigrationForeignKeys
} from "./index.js"

export type MigrationPlan =
  | { readonly kind: "fresh" }
  | { readonly kind: "current" }
  | { readonly kind: "newer"; readonly version: number }
  | {
      readonly kind: "pending"
      readonly from: number
      readonly bridge: SchemaTransitionPath | undefined
    }
  | { readonly kind: "unsupported"; readonly problems: ReadonlyArray<string> }

export const planMigrations = (
  database: DatabaseSync,
  list: ReadonlyArray<Migration> = migrations
): MigrationPlan => {
  const latest = checkMigrationOrder(list)
  const version = readUserVersion(database)
  if (version > latest) return { kind: "newer", version }
  if (version === latest) return { kind: "current" }
  if (version > 0) return { kind: "pending", from: version, bridge: undefined }
  const live = readSchemaManifest(database)
  if (live.length === 0) return { kind: "fresh" }
  const baseline = manifestOf(baselineStatements)
  const foreign = readForeignTableReferences(database, baseline, live)
  const verdict = classifySchemaManifest(baseline, live, foreign)
  if (verdict.kind === "current") return { kind: "pending", from: 0, bridge: undefined }
  const bridge = findSchemaTransition(baseline, live, foreign)
  if (bridge !== undefined) return { kind: "pending", from: 0, bridge }
  return {
    kind: "unsupported",
    problems:
      verdict.kind === "incompatible"
        ? verdict.problems
        : verdict.missing.map((row) => `${row.type}:${row.name} is missing`)
  }
}

export class MigrationError extends Error {
  readonly version: number

  constructor(version: number, name: string, cause: unknown) {
    super(`Migration ${version} (${name}) failed: ${errorMessage(cause)}`, { cause })
    this.name = "MigrationError"
    this.version = version
  }
}

export interface MigrationStep {
  readonly version: number
  readonly name: string
  readonly run: (database: DatabaseSync) => void
}

export const pendingMigrationSteps = (
  plan: Extract<MigrationPlan, { kind: "pending" }>,
  list: ReadonlyArray<Migration> = migrations
): ReadonlyArray<MigrationStep> => {
  const bridge = plan.bridge
  const baseline: ReadonlyArray<MigrationStep> =
    plan.from === 0
      ? [
          {
            version: BASELINE_VERSION,
            name: "baseline",
            run: (database) =>
              migrateInTransaction(database, BASELINE_VERSION, "baseline", WHOLE, () => {
                if (bridge !== undefined) bridgeToBaseline(database, bridge)
              })
          }
        ]
      : []
  return [
    ...baseline,
    ...list
      .filter((migration) => migration.version > plan.from)
      .map((migration): MigrationStep => ({
        version: migration.version,
        name: migration.name,
        run: (database) =>
          migrateInTransaction(
            database,
            migration.version,
            migration.name,
            migration.foreignKeys ?? WHOLE,
            () => migration.up(database)
          )
      }))
  ]
}

const WHOLE: MigrationForeignKeys = { kind: "whole" }

const migrateInTransaction = (
  database: DatabaseSync,
  version: number,
  name: string,
  foreignKeys: MigrationForeignKeys,
  up: () => void
): void => {
  // A table rebuild drops the old table; with enforcement on, that drop runs
  // every child table's ON DELETE action. Enforcement goes off for those, and
  // the check before the commit verifies the references instead. The pragma
  // is a no-op inside a transaction, so it is set before BEGIN.
  database.exec(`PRAGMA foreign_keys = ${foreignKeys.kind === "enforced" ? "ON" : "OFF"}`)
  database.exec("BEGIN IMMEDIATE")
  try {
    up()
    if (hasBrokenReference(database, foreignKeys)) throw new Error("foreign key check failed")
    database.exec(`PRAGMA user_version = ${version}`)
    database.exec("COMMIT")
  } catch (cause) {
    if (database.isTransaction) database.exec("ROLLBACK")
    throw new MigrationError(version, name, cause)
  }
}

interface ForeignKeyReference {
  readonly child: string
  readonly parent: string
}

// SQLite table names compare case-insensitively.
/**
 * The tables to check after `rebuilt` were dropped and recreated: each of
 * them (their own references) and every table that references one of them
 * (a row they lost). SQLite table names compare case-insensitively.
 */
const tablesToCheckAfterRebuild = (
  rebuilt: ReadonlyArray<string>,
  references: ReadonlyArray<ForeignKeyReference>
): ReadonlyArray<string> => {
  const names = new Map(rebuilt.map((table) => [table.toLowerCase(), table]))
  const parents = new Set(names.keys())
  for (const reference of references) {
    if (parents.has(reference.parent.toLowerCase()))
      names.set(reference.child.toLowerCase(), reference.child)
  }
  return [...names.values()].sort()
}

const readForeignKeyReferences = (database: DatabaseSync): ReadonlyArray<ForeignKeyReference> =>
  database
    .prepare(
      `SELECT DISTINCT m.name AS child, f."table" AS parent
       FROM sqlite_schema AS m, pragma_foreign_key_list(m.name) AS f
       WHERE m.type = 'table'`
    )
    .all()
    .map((row) => ({ child: String(row.child), parent: String(row.parent) }))

const hasBrokenReference = (database: DatabaseSync, foreignKeys: MigrationForeignKeys): boolean => {
  switch (foreignKeys.kind) {
    case "enforced":
      return false
    case "whole":
      return database.prepare("PRAGMA foreign_key_check").all().length > 0
    case "rebuilds": {
      const check = database.prepare("SELECT 1 FROM pragma_foreign_key_check(?) LIMIT 1")
      return tablesToCheckAfterRebuild(foreignKeys.tables, readForeignKeyReferences(database)).some(
        (table) => check.get(table) !== undefined
      )
    }
  }
}

/** The pre-migration schema transitions rename a table aside and rebuild it;
 *  legacy ALTER TABLE leaves the child tables' REFERENCES text alone. */
const bridgeToBaseline = (database: DatabaseSync, bridge: SchemaTransitionPath): void => {
  database.exec("PRAGMA legacy_alter_table = ON")
  try {
    applySchemaTransitions(database, bridge)
  } finally {
    database.exec("PRAGMA legacy_alter_table = OFF")
  }
}

const readUserVersion = (database: DatabaseSync): number => {
  const version = database.prepare("PRAGMA user_version").get()?.user_version
  if (typeof version !== "number") throw new Error("SQLite did not report user_version")
  return version
}

/**
 * Opens `filename` to migrate it. Exclusive locking takes the file lock on the
 * first read and keeps it until close, so this fails as busy while any other
 * connection, in this process or another, has the database open, and no
 * connection can open it until the migrations are done.
 */
export const openDatabaseForMigration = (filename: string): DatabaseSync => {
  const database = new DatabaseSync(filename, { timeout: 0 })
  try {
    database.exec("PRAGMA locking_mode = EXCLUSIVE")
    database.prepare("SELECT count(*) FROM sqlite_schema").get()
    return database
  } catch (cause) {
    database.close()
    throw cause
  }
}

/** SQLITE_BUSY or SQLITE_LOCKED (extended codes included): another connection holds the lock. */
export const isDatabaseBusy = (cause: unknown): boolean => {
  if (!(cause instanceof Error) || !("errcode" in cause) || typeof cause.errcode !== "number")
    return false
  const primary = cause.errcode & 0xff
  return primary === 5 || primary === 6
}
