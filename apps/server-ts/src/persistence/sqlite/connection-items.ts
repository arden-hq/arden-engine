import { SIGNAL_SOURCE_IDS } from "@arden-hq/protocol/signals"
import { DateTime, Effect, Option, Schema } from "effect"
import {
  ConnectionItemStore,
  ConnectionItemStoreError,
  type ConnectionItem,
  type ConnectionItemAvailability,
  type ConnectionItemsReport
} from "../connections/store.js"
import { JsonObjectSchema } from "../json.js"
import { nextId, type PersistenceDeps } from "./deps.js"
import { eventThreadLiveSql } from "./event-thread-live.js"

interface ItemRow {
  readonly item_id: string
  readonly source: string
  readonly account: string
  readonly external_id: string
  readonly thread_key: string
  readonly title: string
  readonly sender: string | null
  readonly received_at: string
  readonly snippet: string
  readonly fetched_at: string
  readonly detail: string | null
}

const decodeDetail = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObjectSchema))

export const itemDetailOf = (detail: string | null): ConnectionItem["detail"] =>
  detail === null ? undefined : Option.getOrUndefined(decodeDetail(detail))

const failure =
  (operation: ConnectionItemStoreError["operation"], message: string) =>
  (cause: unknown): ConnectionItemStoreError =>
    cause instanceof ConnectionItemStoreError
      ? cause
      : new ConnectionItemStoreError({ operation, reason: "storage", message, cause })

const project = (row: ItemRow): ConnectionItem => ({
  itemId: row.item_id,
  source: row.source,
  account: row.account,
  externalId: row.external_id,
  threadKey: row.thread_key,
  title: row.title,
  sender: row.sender ?? undefined,
  receivedAt: row.received_at,
  snippet: row.snippet,
  detail: itemDetailOf(row.detail),
  fetchedAt: row.fetched_at
})

export const makeConnectionItemStore = ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">): ConnectionItemStore["Service"] => {
  const sql = writer.sql
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))

  const cursor: ConnectionItemStore["Service"]["cursor"] = (source, account) =>
    reader<{
      readonly cursor: string | null
      readonly poll_after: string | null
      readonly since: string | null
    }>`
      SELECT cursor, poll_after, since FROM connection_cursors WHERE source = ${source} AND account = ${account}`.pipe(
      Effect.map((rows) => {
        const row = rows[0]
        return row === undefined
          ? undefined
          : {
              cursor: row.cursor ?? undefined,
              pollAfter: row.poll_after ?? undefined,
              since: row.since ?? undefined
            }
      }),
      Effect.mapError(failure("cursor", "Could not read the fetch cursor"))
    )

  const threadOwned: ConnectionItemStore["Service"]["threadOwned"] = (input) =>
    reader`SELECT 1 FROM event_threads AS mapped WHERE mapped.source = ${input.source}
      AND mapped.account = ${input.account} AND mapped.thread_key = ${input.threadKey}
      AND ${eventThreadLiveSql(reader, "mapped")}`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(failure("read", "Could not read the thread"))
    )

  const saveFetch: ConnectionItemStore["Service"]["saveFetch"] = Effect.fn(
    "ConnectionItems.saveFetch"
  )(
    function* (input) {
      const ids = yield* Effect.forEach(input.items, () => nextId)
      return yield* writer.transact(
        Effect.gen(function* () {
          const at = yield* now
          let inserted = 0
          for (const [index, item] of input.items.entries()) {
            const rows = yield* sql`INSERT INTO connection_items (item_id, source, account,
              external_id, thread_key, title, sender, received_at, snippet, detail, fetched_at)
              VALUES (${`item_${ids[index]}`}, ${input.source}, ${input.account}, ${item.externalId},
                ${item.threadKey}, ${item.title}, ${item.sender ?? null}, ${item.receivedAt},
                ${item.snippet}, ${item.detail === undefined ? null : JSON.stringify(item.detail)},
                ${at})
              ON CONFLICT(source, account, external_id) DO NOTHING RETURNING item_id`
            for (const row of rows)
              yield* sql`INSERT INTO connection_item_threads (item_id, source, account, thread_key)
                VALUES (${row.item_id}, ${input.source}, ${input.account}, ${item.threadKey})
                ON CONFLICT(item_id) DO NOTHING`
            inserted += rows.length
          }
          yield* sql`INSERT INTO connection_cursors (source, account, cursor, poll_after, polled_at, since,
              watched_from)
            VALUES (${input.source}, ${input.account}, ${input.cursor ?? null}, ${input.pollAfter ?? null}, ${at},
              ${input.since ?? null}, ${at})
            ON CONFLICT(source, account) DO UPDATE SET cursor = excluded.cursor,
              poll_after = excluded.poll_after, polled_at = excluded.polled_at, since = excluded.since`
          return { inserted }
        })
      )
    },
    Effect.mapError(failure("fetch", "Could not save fetched items"))
  )

  const get: ConnectionItemStore["Service"]["get"] = (itemId) =>
    reader<ItemRow>`SELECT * FROM connection_items WHERE item_id = ${itemId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : project(rows[0]))),
      Effect.mapError(failure("read", "Could not read the item"))
    )

  const availability: ConnectionItemStore["Service"]["availability"] = Effect.fn(
    "ConnectionItems.availability"
  )(function* (itemId): Effect.fn.Return<ConnectionItemAvailability, ConnectionItemStoreError> {
    return yield* writer
      .snapshot(
        Effect.gen(function* () {
          const item = yield* get(itemId)
          if (item !== undefined) return { kind: "available", item } as const
          const known =
            yield* reader`SELECT 1 FROM connection_item_threads WHERE item_id = ${itemId}`
          return known.length > 0 ? ({ kind: "expired" } as const) : ({ kind: "unknown" } as const)
        })
      )
      .pipe(Effect.mapError(failure("read", "Could not resolve the item identity")))
  })

  const recent: ConnectionItemStore["Service"]["recent"] = (since, limit) =>
    reader<ItemRow>`SELECT * FROM connection_items WHERE fetched_at >= ${since}
      ORDER BY received_at DESC, item_id LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map(project)),
      Effect.mapError(failure("read", "Could not read recent items"))
    )

  const report: ConnectionItemStore["Service"]["report"] = Effect.fn("ConnectionItems.report")(
    function* (since) {
      const counts = yield* reader<{
        readonly source: string
        readonly fetched: number
      }>`SELECT source, SUM(fetched_at >= ${since}) AS fetched
        FROM connection_items GROUP BY source`
      const offers = yield* reader<{
        readonly offered: number | null
        readonly started: number | null
        readonly skipped: number | null
      }>`SELECT SUM(proposal.status = 'offered') AS offered,
          SUM(proposal.status = 'accepted') AS started,
          SUM(proposal.status = 'rejected' AND proposal.settlement_client_id IS NOT 'item_move') AS skipped
        FROM task_proposals AS proposal
        WHERE proposal.created_at >= ${since}
          AND EXISTS (SELECT 1 FROM json_each(proposal.sources_json) AS cited
            WHERE json_extract(cited.value, '$.kind') = 'connection_item')`
      const fetched = new Map(counts.map((row) => [row.source, row.fetched]))
      return {
        since,
        sources: [...new Set([...SIGNAL_SOURCE_IDS, ...fetched.keys()])].map((source) => ({
          source,
          fetched: fetched.get(source) ?? 0
        })),
        offers: {
          offered: offers[0]?.offered ?? 0,
          started: offers[0]?.started ?? 0,
          skipped: offers[0]?.skipped ?? 0
        }
      } satisfies ConnectionItemsReport
    },
    Effect.mapError(failure("report", "Could not count items"))
  )

  const prune: ConnectionItemStore["Service"]["prune"] = (before) =>
    writer
      .transact(sql`DELETE FROM connection_items WHERE fetched_at < ${before} RETURNING item_id`)
      .pipe(
        Effect.map((rows) => rows.length),
        Effect.mapError(failure("prune", "Could not remove old items"))
      )

  return ConnectionItemStore.of({
    cursor,
    threadOwned,
    saveFetch,
    get,
    availability,
    recent,
    report,
    prune
  })
}
