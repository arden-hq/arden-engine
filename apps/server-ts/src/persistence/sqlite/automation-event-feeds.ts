import { Clock, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import type { AutomationRules, AutomationTriggerEvent } from "../automations/model.js"
import { AutomationStoreError } from "../automations/store.js"
import type { AutomationTriggers, SourceCursorRef } from "../automations/triggers.js"
import type { DispatchInTransaction } from "./automation-event-dispatch.js"
import { storeError } from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"

const ITEMS_BATCH = 200

const ItemCursorSchema = Schema.Struct({
  fetched_at: Schema.String,
  item_id: Schema.String
})

const CONNECTION_ITEMS: SourceCursorRef = {
  eventType: "email.received",
  source: "connection_items"
}

export const makeAutomationEventFeeds = ({
  writer,
  rules,
  dispatchInTransaction
}: Pick<PersistenceDeps, "writer"> & {
  readonly rules: AutomationRules["Service"]
  readonly dispatchInTransaction: DispatchInTransaction
}): Pick<
  AutomationTriggers["Service"],
  "publishConnectionItems" | "readSourceCursor" | "publishSourceEvents" | "releaseSourceCursors"
> => {
  const sql = writer.sql
  const eventSources = (eventType: string) => `event_source:${eventType}:`
  const sourceNamespace = (ref: SourceCursorRef) => `${eventSources(ref.eventType)}${ref.source}`
  const readCursor = (ref: SourceCursorRef) =>
    sql<{ readonly state: string }>`
      SELECT state FROM monitor_state WHERE namespace = ${sourceNamespace(ref)}`.pipe(
      Effect.map(([row]) => row?.state)
    )
  const publish = Effect.fnUntraced(function* (
    ref: SourceCursorRef,
    events: ReadonlyArray<AutomationTriggerEvent | undefined>,
    cursor: string | undefined
  ) {
    let queued = 0
    for (const event of events) {
      if (event !== undefined) queued += (yield* dispatchInTransaction(event)).queued
    }
    if (cursor === undefined) {
      yield* sql`DELETE FROM monitor_state WHERE namespace = ${sourceNamespace(ref)}`
      return { queued }
    }
    yield* sql`
      INSERT INTO monitor_state (namespace, state, updated_at)
      VALUES (${sourceNamespace(ref)}, ${cursor}, ${iso(yield* Clock.currentTimeMillis)})
      ON CONFLICT(namespace) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
    return { queued }
  })
  const publishConnectionItems = Effect.fnUntraced(function* () {
    const state = yield* readCursor(CONNECTION_ITEMS)
    if (state === undefined)
      return yield* publish(CONNECTION_ITEMS, [], JSON.stringify(yield* newestItem(sql)))
    const rows = yield* itemRows(sql, yield* decodeJson(ItemCursorSchema, state))
    const last = rows.at(-1)
    if (last === undefined) return { queued: 0 }
    return yield* publish(
      CONNECTION_ITEMS,
      rows.map(({ row, watched }) => (watched ? rules.connectionItemEvent(row) : undefined)),
      JSON.stringify({ fetched_at: last.fetchedAt, item_id: last.row.itemId })
    )
  })
  const failed = (message: string) => (cause: unknown) =>
    cause instanceof AutomationStoreError
      ? cause
      : storeError("dispatch_event", "storage", message, undefined, cause)
  return {
    publishConnectionItems: () =>
      writer
        .transact(publishConnectionItems())
        .pipe(Effect.mapError(failed("Could not publish connection item events"))),
    readSourceCursor: (ref) =>
      writer
        .transact(readCursor(ref))
        .pipe(Effect.mapError(failed(`Could not read the ${ref.source} cursor`))),
    publishSourceEvents: ({ events, cursor, ...ref }) =>
      writer
        .transact(publish(ref, events, cursor))
        .pipe(Effect.mapError(failed(`Could not publish ${ref.source} events`))),
    releaseSourceCursors: (eventType, options) => {
      const prefix = eventSources(eventType)
      const kept = (options?.keep ?? []).map((source) => sourceNamespace({ eventType, source }))
      return writer
        .transact(
          kept.length === 0
            ? sql`DELETE FROM monitor_state
                WHERE substr(namespace, 1, ${prefix.length}) = ${prefix}`
            : sql`DELETE FROM monitor_state
                WHERE substr(namespace, 1, ${prefix.length}) = ${prefix}
                  AND namespace NOT IN ${sql.in(kept)}`
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError(failed(`Could not release the ${eventType} source cursors`))
        )
    }
  }
}

export const readTaskHistory = (sql: SqlClient.SqlClient, eventId: number) =>
  sql<{
    readonly event_id: number
    readonly event_type: string
    readonly summary: string
    readonly created_at: string
    readonly item_id: string
    readonly stable_key: string
    readonly text: string
    readonly status: string
    readonly blocked: number
    readonly space_id: string | null
    readonly space_name: string | null
  }>`
    SELECT event.event_id, event.event_type, event.summary, event.created_at,
      task.item_id, task.stable_key, task.text, task.status, task.blocked,
      task.space_id, space.name AS space_name
    FROM space_task_events AS event
    JOIN space_tasks AS task ON task.item_id = event.item_id
    LEFT JOIN spaces AS space ON space.space_id = task.space_id
    WHERE event.event_id = ${eventId}
  `.pipe(
    Effect.map(([row]) =>
      row === undefined
        ? undefined
        : {
            eventId: row.event_id,
            kind: row.event_type,
            summary: row.summary,
            at: row.created_at,
            itemId: row.item_id,
            key: row.stable_key,
            text: row.text,
            status: row.status,
            blocked: row.blocked === 1,
            spaceId: row.space_id ?? undefined,
            spaceName: row.space_name ?? undefined
          }
    )
  )

const newestItem = (sql: SqlClient.SqlClient) =>
  sql<{ readonly fetched_at: string; readonly item_id: string }>`
    SELECT fetched_at, item_id FROM connection_items
    ORDER BY fetched_at DESC, item_id DESC LIMIT 1`.pipe(
    Effect.map((rows) => rows[0] ?? { fetched_at: "", item_id: "" })
  )

const itemRows = (
  sql: SqlClient.SqlClient,
  cursor: { readonly fetched_at: string; readonly item_id: string }
) =>
  sql<{
    readonly item_id: string
    readonly source: string
    readonly thread_key: string
    readonly title: string
    readonly sender: string | null
    readonly received_at: string
    readonly snippet: string
    readonly fetched_at: string
    readonly watched: number
  }>`
    SELECT item.item_id, item.source, item.thread_key, item.title, item.sender,
      item.received_at, item.snippet, item.fetched_at,
      (watch.watched_from IS NULL
        OR julianday(item.received_at) >= julianday(watch.watched_from)) AS watched
    FROM connection_items AS item
    LEFT JOIN connection_cursors AS watch
      ON watch.source = item.source AND watch.account = item.account
    WHERE (item.fetched_at, item.item_id) > (${cursor.fetched_at}, ${cursor.item_id})
    ORDER BY item.fetched_at, item.item_id
    LIMIT ${ITEMS_BATCH}
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        fetchedAt: row.fetched_at,
        watched: row.watched === 1,
        row: {
          itemId: row.item_id,
          source: row.source,
          threadKey: row.thread_key,
          title: row.title,
          sender: row.sender ?? undefined,
          receivedAt: row.received_at,
          snippet: row.snippet
        }
      }))
    )
  )
