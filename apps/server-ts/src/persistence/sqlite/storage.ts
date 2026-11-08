import { DEFAULT_STORAGE_SETTINGS, type StorageSettings } from "@arden-hq/protocol/storage"
import { Effect, Schema } from "effect"

import {
  StoragePolicyStore,
  StoragePolicyStoreError,
  type StoragePolicyStoreOperation
} from "../storage/store.js"

import { makeRetentionPolicy } from "./storage-retention.js"
import type { PersistenceDeps } from "./deps.js"

interface StorageSettingsRow {
  readonly max_space_gib: number | null
  readonly allow_archived_session_deletion: number
  readonly allow_inactive_session_deletion: number
  readonly inactive_session_days: number
  readonly minimum_current_sessions: number
}

const StorageSettingsSchema = Schema.Struct({
  maxSpaceGiB: Schema.NullOr(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.1), Schema.isLessThanOrEqualTo(1_000_000))
  ),
  allowArchivedSessionDeletion: Schema.Boolean,
  allowInactiveSessionDeletion: Schema.Boolean,
  inactiveSessionDays: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(3_650)
  ),
  minimumCurrentSessions: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(100_000)
  )
})

const error = (
  operation: StoragePolicyStoreOperation,
  reason: StoragePolicyStoreError["reason"],
  message: string,
  cause?: unknown
) =>
  new StoragePolicyStoreError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const storage = (operation: StoragePolicyStoreOperation, message: string) => (cause: unknown) =>
  cause instanceof StoragePolicyStoreError ? cause : error(operation, "storage", message, cause)

const settingsFromRow = (row: StorageSettingsRow): StorageSettings => ({
  maxSpaceGiB: row.max_space_gib,
  allowArchivedSessionDeletion: row.allow_archived_session_deletion === 1,
  allowInactiveSessionDeletion: row.allow_inactive_session_deletion === 1,
  inactiveSessionDays: row.inactive_session_days,
  minimumCurrentSessions: row.minimum_current_sessions
})

export const makeStoragePolicyStore = Effect.fn("SqliteStoragePolicyStore.make")(function* ({
  writer
}: Pick<PersistenceDeps, "writer">) {
  const sql = writer.sql
  yield* writer
    .run(
      sql`
    INSERT INTO storage_settings (
      singleton_id, max_space_gib,
      allow_archived_session_deletion, allow_inactive_session_deletion,
      inactive_session_days, minimum_current_sessions
    ) VALUES (
      1, ${DEFAULT_STORAGE_SETTINGS.maxSpaceGiB},
      ${DEFAULT_STORAGE_SETTINGS.allowArchivedSessionDeletion ? 1 : 0},
      ${DEFAULT_STORAGE_SETTINGS.allowInactiveSessionDeletion ? 1 : 0},
      ${DEFAULT_STORAGE_SETTINGS.inactiveSessionDays}, ${DEFAULT_STORAGE_SETTINGS.minimumCurrentSessions}
    )
    ON CONFLICT(singleton_id) DO NOTHING
  `
    )
    .pipe(Effect.mapError(storage("settings", "Could not initialize Storage settings")))

  const settings = Effect.fn("SqliteStoragePolicyStore.settings")(function* () {
    const rows = yield* sql<StorageSettingsRow>`
      SELECT max_space_gib,
             allow_archived_session_deletion, allow_inactive_session_deletion,
             inactive_session_days, minimum_current_sessions
      FROM storage_settings
      WHERE singleton_id = 1
      LIMIT 1
    `.pipe(Effect.mapError(storage("settings", "Could not read Storage settings")))
    const row = rows[0]
    if (row === undefined) {
      return yield* error("settings", "storage", "Storage settings are missing")
    }
    return settingsFromRow(row)
  })

  const updateSettings = Effect.fn("SqliteStoragePolicyStore.updateSettings")(function* (
    next: StorageSettings
  ) {
    const settings = yield* Schema.decodeUnknownEffect(StorageSettingsSchema)(next).pipe(
      Effect.mapError((cause) =>
        error("update_settings", "invalid", "Storage settings are invalid", cause)
      )
    )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<StorageSettingsRow>`
        UPDATE storage_settings
        SET max_space_gib = ${settings.maxSpaceGiB},
            allow_archived_session_deletion = ${settings.allowArchivedSessionDeletion ? 1 : 0},
            allow_inactive_session_deletion = ${settings.allowInactiveSessionDeletion ? 1 : 0},
            inactive_session_days = ${settings.inactiveSessionDays},
            minimum_current_sessions = ${settings.minimumCurrentSessions}
        WHERE singleton_id = 1
        RETURNING max_space_gib,
                  allow_archived_session_deletion, allow_inactive_session_deletion,
                  inactive_session_days, minimum_current_sessions
      `.pipe(Effect.mapError(storage("update_settings", "Could not update Storage settings")))
          const row = rows[0]
          if (row === undefined) {
            return yield* error("update_settings", "storage", "Storage settings are missing")
          }
          return settingsFromRow(row)
        })
      )
      .pipe(Effect.mapError(storage("update_settings", "Could not save Storage settings")))
  })

  const retention = makeRetentionPolicy({ writer })
  return StoragePolicyStore.of({
    settings,
    updateSettings,
    retention: retention.read,
    updateRetention: retention.update
  })
})
