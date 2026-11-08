import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect, Option, Schema } from "effect"
import { LATEST_SCHEMA_VERSION } from "../migrations/index.js"
import {
  isDatabaseBusy,
  MigrationError,
  openDatabaseForMigration,
  pendingMigrationSteps,
  planMigrations,
  type MigrationPlan
} from "../migrations/runner.js"
import {
  NEWER_DATA_OPERATION,
  SCHEMA_CONVERT_FAILED_OPERATION,
  StorageStartupError
} from "../service.js"
import { Diagnostics } from "../../runtime/diagnostics.js"
import { writeAtomicSync } from "@arden-hq/std/atomic-file"

export interface ReleaseStorage {
  readonly appVersion: string
  readonly dataDir: string
}

const VERSION_FILE = "app-version.json"
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/

const compareReleaseVersions = (left: string, right: string): number | undefined => {
  const a = RELEASE_VERSION.exec(left)
  const b = RELEASE_VERSION.exec(right)
  if (a === null || b === null) return undefined
  for (const index of [1, 2, 3]) {
    const difference = Number(a[index]) - Number(b[index])
    if (difference !== 0) return difference
  }
  const betaA = a[4] === undefined ? Number.POSITIVE_INFINITY : Number(a[4])
  const betaB = b[4] === undefined ? Number.POSITIVE_INFINITY : Number(b[4])
  return betaA === betaB ? 0 : Math.sign(betaA - betaB)
}

type DataVersionVerdict =
  | { readonly kind: "open"; readonly record: string | undefined }
  | { readonly kind: "newer"; readonly recorded: string }

const dataVersionVerdict = (recorded: string | undefined, current: string): DataVersionVerdict => {
  if (!RELEASE_VERSION.test(current)) return { kind: "open", record: undefined }
  const order = recorded === undefined ? undefined : compareReleaseVersions(recorded, current)
  if (order === undefined) return { kind: "open", record: current }
  if (order > 0 && recorded !== undefined) return { kind: "newer", recorded }
  return { kind: "open", record: order < 0 ? current : undefined }
}

const VersionRecord = Schema.Struct({ version: Schema.String })
const decodeVersionRecord = Schema.decodeUnknownOption(Schema.fromJsonString(VersionRecord))

const guardDataVersion = Effect.fn("SqlitePersistence.guardDataVersion")(function* (
  storage: ReleaseStorage
) {
  const file = join(storage.dataDir, VERSION_FILE)
  const text = yield* Effect.try(() => readFileSync(file, "utf8")).pipe(
    Effect.orElseSucceed(() => undefined)
  )
  const recorded =
    text === undefined
      ? undefined
      : Option.getOrUndefined(Option.map(decodeVersionRecord(text), (record) => record.version))
  const verdict = dataVersionVerdict(recorded, storage.appVersion)
  if (verdict.kind === "newer") {
    return yield* new StorageStartupError({
      operation: NEWER_DATA_OPERATION,
      message: `This data was last opened by Arden ${verdict.recorded}, which is newer than this Arden ${storage.appVersion}. Install ${verdict.recorded} or newer.`
    })
  }
  return verdict.record
})

export const prepareReleaseStorage = Effect.fn("SqlitePersistence.prepareReleaseStorage")(
  function* (filename: string, storage: ReleaseStorage) {
    const version = yield* guardDataVersion(storage)
    yield* migrateAtStartup(filename)
    return version === undefined ? undefined : { storage, version }
  }
)

export const recordDataVersion = Effect.fn("SqlitePersistence.recordDataVersion")(function* (
  storage: ReleaseStorage,
  record: string
) {
  const file = join(storage.dataDir, VERSION_FILE)
  yield* Effect.try(() => {
    writeAtomicSync(file, `${JSON.stringify({ version: record })}\n`)
  }).pipe(Effect.catch((cause) => Effect.logWarning("Could not record the app version", { cause })))
})

export const migrateAtStartup = Effect.fn("SqlitePersistence.migrateAtStartup")(function* (
  filename: string
) {
  if (!existsSync(filename)) return
  const diagnostics = yield* Diagnostics
  const plan = yield* Effect.try({
    try: () => {
      const database = new DatabaseSync(filename, { readOnly: true })
      try {
        return planMigrations(database)
      } finally {
        database.close()
      }
    },
    catch: (cause) => initError("Could not read the SQLite schema version", cause)
  })
  if (plan.kind === "newer") return yield* newerDataError(plan.version)
  if (plan.kind !== "pending") return
  yield* diagnostics.startupPhase("schema_conversion_started")
  yield* flushHostPort
  const database = yield* Effect.try({
    try: () => openDatabaseForMigration(filename),
    catch: (cause) =>
      initError(
        isDatabaseBusy(cause)
          ? "Another Arden process has this data open; quit it and start Arden again"
          : "Could not open the SQLite database to migrate it",
        cause
      )
  })
  const outcome = yield* runPendingMigrations(database).pipe(
    Effect.map((plan): MigrationOutcome => ({ kind: "done", plan })),
    Effect.catch((failure) => Effect.succeed<MigrationOutcome>({ kind: "failed", ...failure })),
    Effect.ensuring(Effect.sync(() => database.close()))
  )
  if (outcome.kind === "failed") {
    return yield* new StorageStartupError({
      operation:
        outcome.cause instanceof MigrationError ? SCHEMA_CONVERT_FAILED_OPERATION : "initialize",
      message:
        outcome.cause instanceof MigrationError
          ? outcome.cause.message
          : "Could not migrate the SQLite database",
      cause: outcome.cause
    })
  }
  if (outcome.plan.kind === "newer") return yield* newerDataError(outcome.plan.version)
  if (outcome.plan.kind === "pending") {
    yield* Effect.logInfo("Migrated the database", {
      from: outcome.plan.from,
      to: LATEST_SCHEMA_VERSION
    })
  }
})

const runPendingMigrations = Effect.fn("SqlitePersistence.runPendingMigrations")(function* (
  database: DatabaseSync
) {
  const diagnostics = yield* Diagnostics
  const attempt = <A>(run: () => A) =>
    Effect.try({ try: run, catch: (cause): MigrationRunFailure => ({ cause }) })
  const plan = yield* attempt(() => planMigrations(database))
  if (plan.kind !== "pending") return plan
  const steps = pendingMigrationSteps(plan)
  for (const [index, step] of steps.entries()) {
    yield* diagnostics.migration({ step: index + 1, total: steps.length, name: step.name })
    yield* flushHostPort
    yield* attempt(() => step.run(database))
  }
  return plan
})

interface MigrationRunFailure {
  readonly cause: unknown
}

const flushHostPort = Effect.callback<void>((resume) => {
  let immediate: NodeJS.Immediate | undefined
  const timer = setTimeout(() => {
    immediate = setImmediate(() => resume(Effect.void))
  }, 0)
  return Effect.sync(() => {
    clearTimeout(timer)
    if (immediate !== undefined) clearImmediate(immediate)
  })
})

type MigrationOutcome =
  | { readonly kind: "done"; readonly plan: MigrationPlan }
  | { readonly kind: "failed"; readonly cause: unknown }

const newerDataError = (version: number): StorageStartupError =>
  new StorageStartupError({
    operation: NEWER_DATA_OPERATION,
    message: `This data was written by a newer Arden (database version ${version}; this Arden reads up to ${LATEST_SCHEMA_VERSION}). Install the newest Arden.`
  })

const initError = (message: string, cause: unknown): StorageStartupError =>
  new StorageStartupError({ operation: "initialize", message, cause })
