import { DatabaseSync } from "node:sqlite"
import { errorMessage } from "@arden-hq/std/errors"
import {
  classifySchemaManifest,
  manifestOf,
  readForeignTableReferences,
  readSchemaManifest,
  SCHEMA_MANIFEST_VERDICT
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
  FOREIGN_KEY_CHECK,
  migrations,
  type Migration,
  type MigrationForeignKeys
} from "./index.js"

export const MIGRATION_PLAN = {
  fresh: "fresh",
  current: "current",
  newer: "newer",
  pending: "pending",
  unsupported: "unsupported"
} as const

export type MigrationPlan =
  | { readonly kind: typeof MIGRATION_PLAN.fresh }
  | { readonly kind: typeof MIGRATION_PLAN.current }
  | { readonly kind: typeof MIGRATION_PLAN.newer; readonly version: number }
  | {
      readonly kind: typeof MIGRATION_PLAN.pending
      readonly from: number
      readonly bridge: SchemaTransitionPath | undefined
    }
  | { readonly kind: typeof MIGRATION_PLAN.unsupported; readonly problems: ReadonlyArray<string> }

export const planMigrations = (
  database: DatabaseSync,
  list: ReadonlyArray<Migration> = migrations
): MigrationPlan => {
  const latest = checkMigrationOrder(list)
  const version = readUserVersion(database)
  if (version > latest) return { kind: MIGRATION_PLAN.newer, version }
  if (version === latest) return { kind: MIGRATION_PLAN.current }
  if (version > 0) return { kind: MIGRATION_PLAN.pending, from: version, bridge: undefined }
  const live = readSchemaManifest(database)
  if (live.length === 0) return { kind: MIGRATION_PLAN.fresh }
  const baseline = manifestOf(baselineStatements)
  const foreign = readForeignTableReferences(database, baseline, live)
  const verdict = classifySchemaManifest(baseline, live, foreign)
  if (verdict.kind === SCHEMA_MANIFEST_VERDICT.current)
    return { kind: MIGRATION_PLAN.pending, from: 0, bridge: undefined }
  const bridge = findSchemaTransition(baseline, live, foreign)
  if (bridge !== undefined) return { kind: MIGRATION_PLAN.pending, from: 0, bridge }
  return {
    kind: MIGRATION_PLAN.unsupported,
    problems:
      verdict.kind === SCHEMA_MANIFEST_VERDICT.incompatible
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
  plan: Extract<MigrationPlan, { kind: typeof MIGRATION_PLAN.pending }>,
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

const WHOLE: MigrationForeignKeys = { kind: FOREIGN_KEY_CHECK.whole }

const migrateInTransaction = (
  database: DatabaseSync,
  version: number,
  name: string,
  foreignKeys: MigrationForeignKeys,
  up: () => void
): void => {
  // PRAGMA foreign_keys is a no-op inside a transaction, so it is set before BEGIN: https://www.sqlite.org/pragma.html#pragma_foreign_keys
  database.exec(
    `PRAGMA foreign_keys = ${foreignKeys.kind === FOREIGN_KEY_CHECK.enforced ? "ON" : "OFF"}`
  )
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

const sqliteTableKey = (table: string): string => table.toLowerCase()

const tablesToCheckAfterRebuild = (
  rebuilt: ReadonlyArray<string>,
  references: ReadonlyArray<ForeignKeyReference>
): ReadonlyArray<string> => {
  const names = new Map(rebuilt.map((table) => [sqliteTableKey(table), table]))
  const parents = new Set(names.keys())
  for (const reference of references) {
    if (parents.has(sqliteTableKey(reference.parent)))
      names.set(sqliteTableKey(reference.child), reference.child)
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
    case FOREIGN_KEY_CHECK.enforced:
      return false
    case FOREIGN_KEY_CHECK.whole:
      return database.prepare("PRAGMA foreign_key_check").all().length > 0
    case FOREIGN_KEY_CHECK.rebuilds: {
      const check = database.prepare("SELECT 1 FROM pragma_foreign_key_check(?) LIMIT 1")
      return tablesToCheckAfterRebuild(foreignKeys.tables, readForeignKeyReferences(database)).some(
        (table) => check.get(table) !== undefined
      )
    }
  }
}

const bridgeToBaseline = (database: DatabaseSync, bridge: SchemaTransitionPath): void => {
  // A table renamed aside keeps the REFERENCES text of its child tables: https://www.sqlite.org/pragma.html#pragma_legacy_alter_table
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

const holdFileLockUntilClose = (database: DatabaseSync): void => {
  database.exec("PRAGMA locking_mode = EXCLUSIVE")
  database.prepare("SELECT count(*) FROM sqlite_schema").get()
}

export const openDatabaseForMigration = (filename: string): DatabaseSync => {
  const database = new DatabaseSync(filename, { timeout: 0 })
  try {
    holdFileLockUntilClose(database)
    return database
  } catch (cause) {
    database.close()
    throw cause
  }
}

const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const primaryResultCode = (extendedCode: number): number => extendedCode & 0xff

export const isDatabaseBusy = (cause: unknown): boolean => {
  if (!(cause instanceof Error) || !("errcode" in cause) || typeof cause.errcode !== "number")
    return false
  const primary = primaryResultCode(cause.errcode)
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED
}
