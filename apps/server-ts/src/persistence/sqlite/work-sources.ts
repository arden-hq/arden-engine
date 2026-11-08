import type { SpaceTaskSource } from "@arden-hq/protocol/spaces/work"
import { SpaceTaskSourceSchema } from "@arden-hq/protocol/effect/spaces/work"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { WorkStoreError } from "../work/store.js"
import { decodeJson } from "./json.js"

export const taskSourceKey = (source: SpaceTaskSource): string => {
  switch (source.kind) {
    case "chat":
      return JSON.stringify([source.kind, source.session_id, source.turn_id, source.revision])
    case "memory":
      return JSON.stringify([source.kind, source.page_ref, source.revision])
    case "task":
      return JSON.stringify([source.kind, source.item_id, source.revision])
    case "space":
      return JSON.stringify([source.kind, source.space_id, source.revision])
    case "connection_item":
      return JSON.stringify([source.kind, source.item_id, source.revision])
  }
}

export const makeWorkSourceSql = (sql: SqlClient.SqlClient) => {
  const add = Effect.fn("WorkSources.add")(function* (options: {
    readonly itemId: string
    readonly sources: ReadonlyArray<SpaceTaskSource>
    readonly now: string
  }) {
    const sources = yield* Schema.decodeUnknownEffect(Schema.Array(SpaceTaskSourceSchema))(
      options.sources,
      { onExcessProperty: "error" }
    ).pipe(
      Effect.mapError(
        (cause) =>
          new WorkStoreError({
            reason: "invalid",
            message: "Invalid Task source",
            cause
          })
      )
    )
    for (const source of sources) {
      yield* sql`
        INSERT INTO space_task_sources (item_id, source_key, source, created_at)
        VALUES (${options.itemId}, ${taskSourceKey(source)}, ${JSON.stringify(source)}, ${options.now})
        ON CONFLICT(item_id, source_key) DO NOTHING
      `.pipe(
        Effect.mapError(
          (cause) =>
            new WorkStoreError({
              reason: "storage",
              message: "Could not capture Task source",
              cause
            })
        )
      )
    }
  })

  const read = Effect.fn("WorkSources.read")(function* (itemIds: ReadonlyArray<string>) {
    const result = new Map<string, Array<SpaceTaskSource>>()
    if (itemIds.length === 0) return result
    const rows = yield* sql<{ readonly item_id: string; readonly source: string }>`
      SELECT item_id, source FROM space_task_sources
      WHERE ${sql.in("item_id", itemIds)}
      ORDER BY created_at, source_key
    `.pipe(
      Effect.mapError(
        (cause) =>
          new WorkStoreError({
            reason: "storage",
            message: "Could not read Task sources",
            cause
          })
      )
    )
    for (const row of rows) {
      const source = yield* decodeJson(SpaceTaskSourceSchema, row.source).pipe(
        Effect.mapError(
          (cause) =>
            new WorkStoreError({
              reason: "storage",
              message: "Stored Task source is corrupt",
              cause
            })
        )
      )
      const sources = result.get(row.item_id) ?? []
      sources.push(source)
      result.set(row.item_id, sources)
    }
    return result
  })

  return { add, read }
}
