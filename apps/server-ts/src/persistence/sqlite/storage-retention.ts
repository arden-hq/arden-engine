import {
  DEFAULT_STORAGE_RETENTION,
  RETENTION,
  type RetentionPeriod,
  type StorageRetention
} from "@arden-hq/protocol/storage"
import { StorageRetentionSchema } from "@arden-hq/protocol/effect/storage"
import { Effect, Schema } from "effect"
import { StoragePolicyStoreError, type StoragePolicyStore } from "../storage/store.js"
import type { PersistenceDeps } from "./deps.js"

export interface RetentionPolicy {
  readonly read: StoragePolicyStore["Service"]["retention"]
  readonly update: StoragePolicyStore["Service"]["updateRetention"]
}

const periodOf = (days: number | null): RetentionPeriod =>
  days === null ? { kind: RETENTION.forever } : { kind: RETENTION.days, days }

const daysOf = (period: RetentionPeriod): number | null =>
  period.kind === RETENTION.days ? period.days : null

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
      const value = yield* Schema.decodeUnknownEffect(StorageRetentionSchema)({
        agent_trace: periodOf(row.agent_trace_days),
        wiki_history: periodOf(row.wiki_history_days)
      })
      return { agentTrace: value.agent_trace, wikiHistory: value.wiki_history }
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
        agent_trace: settings.agentTrace,
        wiki_history: settings.wikiHistory
      })
      yield* writer.run(sql`
      INSERT INTO storage_retention (singleton_id, agent_trace_days, wiki_history_days)
      VALUES (1, ${daysOf(value.agent_trace)}, ${daysOf(value.wiki_history)})
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
