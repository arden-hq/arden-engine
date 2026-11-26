import { SQLITE_OBJECT_TYPE } from "../schema/manifest.js"
import { SCHEMA_MANIFEST_VERDICT } from "../schema/manifest.js"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { databaseSchema } from "../schema/database.js"
import { LATEST_SCHEMA_VERSION } from "../migrations/index.js"
import {
  buildReferenceSchemaManifest,
  classifySchemaManifest,
  schemaIdentity,
  type SchemaManifestRow
} from "../schema/manifest.js"
import { StorageStartupError } from "../service.js"
import { Diagnostics } from "../../runtime/diagnostics.js"

export const initError = (message: string, cause?: unknown): StorageStartupError =>
  new StorageStartupError({
    operation: "initialize",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const probePragma = Effect.fn("SqlitePersistence.probePragma")(function* (
  sql: SqlClient.SqlClient,
  pragma: "auto_vacuum" | "synchronous"
) {
  const rows = yield* sql
    .unsafe<Record<string, unknown>>(`PRAGMA ${pragma}`)
    .pipe(Effect.mapError((cause) => initError(`Could not inspect SQLite ${pragma}`, cause)))
  const value = rows[0]?.[pragma]
  if (typeof value !== "number") {
    return yield* initError(`SQLite did not report ${pragma}`)
  }
  return value
})

const SQLITE_WAL_JOURNAL_MODE = "wal"
const SQLITE_MEMORY_JOURNAL_MODE = "memory"
const SQLITE_MAIN_DATABASE = "main"

const verifyJournalMode = Effect.fn("SqlitePersistence.verifyJournalMode")(function* (
  sql: SqlClient.SqlClient
) {
  const rows = yield* sql
    .unsafe<{ readonly journal_mode: unknown }>("PRAGMA journal_mode")
    .pipe(Effect.mapError((cause) => initError("Could not inspect SQLite journal mode", cause)))
  const journalMode = rows[0]?.journal_mode
  if (journalMode === SQLITE_WAL_JOURNAL_MODE) return
  if (journalMode === SQLITE_MEMORY_JOURNAL_MODE) {
    const databases = yield* sql
      .unsafe<{
        readonly name: unknown
        readonly file: unknown
      }>("PRAGMA database_list")
      .pipe(Effect.mapError((cause) => initError("Could not inspect SQLite database files", cause)))
    if (
      databases.some((database) => database.name === SQLITE_MAIN_DATABASE && database.file === "")
    )
      return
  }
  return yield* initError(
    `SQLite journal mode is ${String(journalMode)}; file-backed current storage requires WAL`
  )
})

const configureConnection = Effect.fn("SqlitePersistence.configureConnection")(function* (
  sql: SqlClient.SqlClient
) {
  yield* verifyJournalMode(sql)
  yield* sql
    .unsafe("PRAGMA synchronous = NORMAL")
    .pipe(
      Effect.mapError((cause) => initError("Could not configure SQLite synchronous mode", cause))
    )
  const synchronous = yield* probePragma(sql, "synchronous")
  if (synchronous !== 1) {
    return yield* initError(
      `SQLite synchronous mode is ${synchronous}; the current storage baseline requires NORMAL (1)`
    )
  }
})

const prepareFreshStorage = Effect.fn("SqlitePersistence.prepareFreshStorage")(function* (
  sql: SqlClient.SqlClient
) {
  yield* sql
    .unsafe("PRAGMA auto_vacuum = INCREMENTAL")
    .pipe(
      Effect.mapError((cause) =>
        initError("Could not configure SQLite incremental auto-vacuum", cause)
      )
    )
  let autoVacuum = yield* probePragma(sql, "auto_vacuum")
  if (autoVacuum !== 2) {
    yield* sql
      .unsafe("VACUUM")
      .pipe(
        Effect.mapError((cause) =>
          initError("Could not initialize SQLite incremental auto-vacuum", cause)
        )
      )
    autoVacuum = yield* probePragma(sql, "auto_vacuum")
  }
  if (autoVacuum !== 2) {
    return yield* initError(
      `SQLite auto_vacuum mode is ${autoVacuum}; the current storage baseline requires INCREMENTAL (2)`
    )
  }
})

const readLiveSchemaManifest = (sql: SqlClient.SqlClient) =>
  sql<SchemaManifestRow>`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*'
    ORDER BY type, name
  `.pipe(
    Effect.mapError((cause) => initError("Could not inspect the SQLite schema manifest", cause))
  )

const probeSchemaManifest = Effect.fn("SqlitePersistence.probeSchemaManifest")(function* (
  sql: SqlClient.SqlClient
) {
  const diagnostics = yield* Diagnostics
  const referenceRows = yield* Effect.try({
    try: buildReferenceSchemaManifest,
    catch: (cause) => initError("Could not build the current SQLite schema manifest", cause)
  })
  const liveRows = yield* readLiveSchemaManifest(sql)
  const reference = new Set(referenceRows.map(schemaIdentity))
  const foreignTables = liveRows.filter(
    (row) => row.type === SQLITE_OBJECT_TYPE.table && !reference.has(schemaIdentity(row))
  )
  const foreignReferences = new Map(
    yield* Effect.forEach(foreignTables, (row) =>
      sql<{ readonly target: string }>`
      SELECT "table" AS target FROM pragma_foreign_key_list(${row.name}) ORDER BY id, seq
    `.pipe(
        Effect.map((references) => [row.name, references.map((item) => item.target)] as const),
        Effect.mapError((cause) =>
          initError(`Could not inspect foreign table dependencies for ${row.name}`, cause)
        )
      )
    )
  )
  const verdict = classifySchemaManifest(referenceRows, liveRows, foreignReferences)
  if (verdict.foreign.length > 0) {
    yield* Effect.logWarning("Foreign SQLite schema objects are present", {
      verdict: "foreign_warning",
      objects: verdict.foreign.map((row) => `${row.type}:${row.name}`).join(", ")
    })
    yield* Effect.forEach(
      verdict.foreign,
      (row) =>
        diagnostics.operational({
          code: "storage.schema_drift",
          severity: "warning",
          objectType: row.type,
          objectName: row.name,
          verdict: "foreign_warning"
        }),
      { discard: true }
    )
  }
  if (verdict.kind === SCHEMA_MANIFEST_VERDICT.incompatible) {
    yield* Effect.forEach(
      verdict.problems,
      (problem) => {
        const identity = problem.split(" ")[0] ?? "manifest:unknown"
        const separator = identity.indexOf(":")
        return diagnostics.operational({
          code: "storage.schema_drift",
          severity: "error",
          cause: problem,
          objectType: separator < 0 ? "manifest" : identity.slice(0, separator),
          objectName: separator < 0 ? identity : identity.slice(separator + 1),
          verdict: "owned_fatal"
        })
      },
      { discard: true }
    )
    return yield* initError(
      `SQLite schema manifest is incompatible; ${verdict.problems.join("; ")}`
    )
  }
  if (verdict.kind === SCHEMA_MANIFEST_VERDICT.conversionRequired) {
    return yield* initError(
      `SQLite schema is missing: ${verdict.missing
        .map((row) => `${row.type}:${row.name}`)
        .join(", ")}`
    )
  }
})

const probeSchemaVersion = Effect.fn("SqlitePersistence.probeSchemaVersion")(function* (
  sql: SqlClient.SqlClient
) {
  const rows = yield* sql<{ readonly user_version: number }>`PRAGMA user_version`.pipe(
    Effect.mapError((cause) => initError("Could not read the SQLite schema version", cause))
  )
  const version = rows[0]?.user_version
  if (version !== LATEST_SCHEMA_VERSION) {
    return yield* initError(
      `SQLite schema version is ${String(version)}; this build requires ${LATEST_SCHEMA_VERSION}`
    )
  }
})

const probeModelSettingsSingleton = Effect.fn("SqlitePersistence.probeModelSettingsSingleton")(
  function* (sql: SqlClient.SqlClient) {
    const rows = yield* sql<{ readonly singleton_id: number }>`
    SELECT singleton_id FROM model_settings
  `.pipe(
      Effect.mapError((cause) => initError("Could not inspect the model settings singleton", cause))
    )
    if (rows.length !== 1 || rows[0]?.singleton_id !== 1) {
      return yield* initError("SQLite model settings singleton is not the current baseline")
    }
  }
)

export const initializeSchema = Effect.fn("SqlitePersistence.initializeSchema")(function* (
  sql: SqlClient.SqlClient
) {
  yield* configureConnection(sql)
  yield* sql
    .unsafe("PRAGMA foreign_keys = ON")
    .pipe(Effect.mapError((cause) => initError("Could not enable SQLite foreign keys", cause)))
  const existing = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*'
    LIMIT 1
  `.pipe(Effect.mapError((cause) => initError("Could not inspect SQLite schema", cause)))
  if (existing.length === 0) {
    yield* prepareFreshStorage(sql)
    yield* sql
      .withTransaction(
        Effect.forEach(databaseSchema.statements, (statement) => sql.unsafe(statement), {
          discard: true
        }).pipe(Effect.andThen(sql.unsafe(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`)))
      )
      .pipe(Effect.mapError((cause) => initError("Could not initialize SQLite schema", cause)))
  }
  yield* probeSchemaManifest(sql)
  yield* probeSchemaVersion(sql)
  yield* probeModelSettingsSingleton(sql)
})
