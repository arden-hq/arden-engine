import { DateTime, Effect, Schema } from "effect"
import type { PersistenceDeps } from "./deps.js"

export type SettingsDocumentOperation = "settings" | "update_settings"

export interface SettingsDocumentFailure {
  readonly operation: SettingsDocumentOperation
  readonly reason: "invalid" | "storage"
  readonly message: string
  readonly cause?: unknown
}

interface SettingsRow {
  readonly state: string
}

export const makeSettingsDocument = Effect.fn("SqliteSettingsDocument.make")(function* <
  A,
  P extends object,
  E
>(options: {
  readonly writer: PersistenceDeps["writer"]
  readonly namespace: string
  readonly label: string
  readonly schema: Schema.Codec<A, unknown>
  readonly patchSchema: Schema.Codec<P, unknown>
  readonly defaults: A
  readonly error: new (failure: SettingsDocumentFailure) => E
}) {
  const { writer, namespace, label } = options
  const Label = label.charAt(0).toUpperCase() + label.slice(1)
  const Failure = options.error
  const sql = writer.sql
  const json = Schema.fromJsonString(options.schema)
  const failure = (
    operation: SettingsDocumentOperation,
    reason: SettingsDocumentFailure["reason"],
    message: string,
    cause?: unknown
  ) => new Failure({ operation, reason, message, ...(cause === undefined ? {} : { cause }) })
  const storage = (operation: SettingsDocumentOperation, message: string) => (cause: unknown) =>
    cause instanceof Failure ? cause : failure(operation, "storage", message, cause)
  const decode = (value: string, operation: SettingsDocumentOperation) =>
    Schema.decodeUnknownEffect(json)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) =>
        failure(operation, "storage", `Stored ${label} are corrupt`, cause)
      )
    )
  const encode = (value: A, operation: SettingsDocumentOperation) =>
    Schema.encodeEffect(json)(value).pipe(
      Effect.mapError((cause) => failure(operation, "invalid", `${Label} cannot be encoded`, cause))
    )

  const initial = yield* encode(options.defaults, "settings")
  const initializedAt = DateTime.formatIso(yield* DateTime.now)
  yield* writer
    .run(
      sql`
    INSERT INTO monitor_state (namespace, state, updated_at)
    VALUES (${namespace}, ${initial}, ${initializedAt})
    ON CONFLICT(namespace) DO NOTHING
  `
    )
    .pipe(Effect.mapError(storage("settings", `Could not initialize ${label}`)))

  const read = Effect.fn("SqliteSettingsDocument.read")(function* () {
    const rows = yield* sql<SettingsRow>`
      SELECT state FROM monitor_state WHERE namespace = ${namespace} LIMIT 1
    `.pipe(Effect.mapError(storage("settings", `Could not read ${label}`)))
    const row = rows[0]
    if (row === undefined)
      return yield* Effect.fail(failure("settings", "storage", `${Label} are missing`))
    return yield* decode(row.state, "settings")
  })

  const updateInTransaction = Effect.fn("SqliteSettingsDocument.updateInTransaction")(function* (
    patch: P | ((current: A) => P)
  ) {
    const current = yield* read()
    const validPatch = yield* Schema.decodeUnknownEffect(options.patchSchema)(
      typeof patch === "function" ? patch(current) : patch,
      { onExcessProperty: "error" }
    ).pipe(
      Effect.mapError((cause) =>
        failure("update_settings", "invalid", `Invalid ${label} patch`, cause)
      )
    )
    const next = yield* Schema.decodeUnknownEffect(options.schema)(
      { ...current, ...validPatch },
      { onExcessProperty: "error" }
    ).pipe(
      Effect.mapError((cause) => failure("update_settings", "invalid", `Invalid ${label}`, cause))
    )
    const state = yield* encode(next, "update_settings")
    const updatedAt = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* sql<SettingsRow>`
  UPDATE monitor_state
  SET state = ${state}, updated_at = ${updatedAt}
  WHERE namespace = ${namespace}
  RETURNING state
`.pipe(Effect.mapError(storage("update_settings", `Could not update ${label}`)))
    const row = rows[0]
    if (row === undefined)
      return yield* Effect.fail(failure("update_settings", "storage", `${Label} are missing`))
    return yield* decode(row.state, "update_settings")
  })
  const update = (patch: P | ((current: A) => P)) =>
    writer
      .transact(updateInTransaction(patch))
      .pipe(Effect.mapError(storage("update_settings", `Could not save ${label}`)))

  return { read, update, updateInTransaction }
})
