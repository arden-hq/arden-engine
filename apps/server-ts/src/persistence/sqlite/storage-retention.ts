import { DEFAULT_STORAGE_RETENTION, type StorageRetention } from "@arden-hq/protocol/storage"
import { StorageRetentionSchema } from "@arden-hq/protocol/effect/storage"
import { Effect, Schema } from "effect"
import { StoragePolicyStoreError, type StoragePolicyStore } from "../storage/store.js"
import type { PersistenceDeps } from "./deps.js"

export interface RetentionPolicy {
  readonly read: StoragePolicyStore["Service"]["retention"]
  readonly update: StoragePolicyStore["Service"]["updateRetention"]
}

export const makeRetentionPolicy = ({
  writer
}: Pick<PersistenceDeps, "writer">): RetentionPolicy => {
  const sql = writer.sql
  const read = Effect.fn("StorageRetention.read")(
    function* () {
      const rows = yield* sql<{
        agent_trace_days: number | null
        wiki_history_days: number | null
      }>`
      SELECT agent_trace_days, wiki_history_days FROM storage_retention WHERE singleton_id = 1
    `
      const row = rows[0]
      if (row === undefined) return DEFAULT_STORAGE_RETENTION
      const value = yield* Schema.decodeUnknownEffect(StorageRetentionSchema)(row)
      return { agentTraceDays: value.agent_trace_days, wikiHistoryDays: value.wiki_history_days }
    },
    Effect.mapError(
      (cause) =>
        new StoragePolicyStoreError({
          operation: "settings",
          reason: "storage",
          message: "Could not read retention settings",
          cause
        })
    )
  )

  const update = Effect.fn("StorageRetention.update")(
    function* (settings: StorageRetention) {
      const value = yield* Schema.decodeUnknownEffect(StorageRetentionSchema)({
        agent_trace_days: settings.agentTraceDays,
        wiki_history_days: settings.wikiHistoryDays
      })
      yield* writer.run(sql`
      INSERT INTO storage_retention (singleton_id, agent_trace_days, wiki_history_days)
      VALUES (1, ${value.agent_trace_days}, ${value.wiki_history_days})
      ON CONFLICT(singleton_id) DO UPDATE SET
        agent_trace_days = excluded.agent_trace_days,
        wiki_history_days = excluded.wiki_history_days
    `)
      return settings
    },
    Effect.mapError(
      (cause) =>
        new StoragePolicyStoreError({
          operation: "update_settings",
          reason: "storage",
          message: "Could not save retention settings",
          cause
        })
    )
  )
  return { read, update }
}
