import { SIGNAL_SOURCE_IDS } from "@arden-hq/protocol/signals"
import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  ConnectionItemStore,
  ConnectionItemStoreError,
  type ConnectionItem,
  type ConnectionItemAvailability,
  type ConnectionItemsReport,
  type RouteBasis,
  type RouteDecision
} from "../connections/store.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { openHeldOnHome } from "./proposal-room.js"
import { nextId, type PersistenceDeps } from "./deps.js"
import { routeItem } from "./connection-item-route.js"
import { openProposalStatusList } from "./status-sets.js"

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
  readonly state: "pending" | "routed"
  readonly owner_space_id: string | null
  readonly route_basis: RouteBasis | null
  readonly route_reason: string | null
  readonly routed_at: string | null
}

const citesAny = (sql: SqlClient.SqlClient, itemIds: string) =>
  sql`EXISTS (SELECT 1 FROM json_each(task_proposals.sources_json) AS cited
    WHERE json_extract(cited.value, '$.kind') = 'connection_item'
      AND json_extract(cited.value, '$.item_id') IN (SELECT value FROM json_each(${itemIds})))`

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
  fetchedAt: row.fetched_at,
  route:
    row.state === "pending" || row.route_basis === null || row.routed_at === null
      ? { kind: "pending" }
      : {
          kind: "routed",
          spaceId: row.owner_space_id ?? undefined,
          basis: row.route_basis,
          reason: row.route_reason ?? "",
          routedAt: row.routed_at
        }
})

export const makeConnectionItemStore = ({
  writer,
  reader,
  sessionEvents
}: Pick<
  PersistenceDeps,
  "writer" | "reader" | "sessionEvents"
>): ConnectionItemStore["Service"] => {
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
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
    reader`SELECT 1 FROM connection_threads WHERE source = ${input.source}
      AND account = ${input.account} AND thread_key = ${input.threadKey}`.pipe(
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
              external_id, thread_key, title, sender, received_at, snippet, fetched_at, state)
              VALUES (${`item_${ids[index]}`}, ${input.source}, ${input.account}, ${item.externalId},
                ${item.threadKey}, ${item.title}, ${item.sender ?? null}, ${item.receivedAt},
                ${item.snippet}, ${at}, 'pending')
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

  const pending: ConnectionItemStore["Service"]["pending"] = (limit) =>
    reader<ItemRow>`SELECT * FROM connection_items WHERE state = 'pending'
      ORDER BY fetched_at, received_at, item_id LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map(project)),
      Effect.mapError(failure("read", "Could not read pending items"))
    )

  const routeAll = Effect.fnUntraced(function* (
    decisions: ReadonlyArray<RouteDecision>,
    at: string
  ) {
    const spaces = new Set<string>()
    for (const decision of decisions) {
      const routed = yield* routeItem(sql, { ...decision, now: at })
      if (routed.changed && routed.spaceId !== undefined) spaces.add(routed.spaceId)
    }
    for (const spaceId of spaces) yield* spaceJobs.queueItemsRouted(spaceId, at)
  })

  const route: ConnectionItemStore["Service"]["route"] = Effect.fn("ConnectionItems.route")(
    function* (decisions) {
      return yield* writer.transact(routeAll(decisions, yield* now))
    },
    Effect.mapError(failure("route", "Could not route items"))
  )

  const routeOwnedThreads: ConnectionItemStore["Service"]["routeOwnedThreads"] = Effect.fn(
    "ConnectionItems.routeOwnedThreads"
  )(
    function* () {
      const at = yield* now
      return yield* writer.transact(
        Effect.gen(function* () {
          const owned = yield* sql<{ readonly item_id: string }>`SELECT item.item_id
            FROM connection_items AS item JOIN connection_threads AS thread
              ON thread.source = item.source AND thread.account = item.account
                AND thread.thread_key = item.thread_key
            WHERE item.state = 'pending' ORDER BY item.fetched_at, item.item_id`
          return yield* routeAll(
            owned.map((row) => ({
              itemId: row.item_id,
              spaceId: undefined,
              basis: "thread" as const,
              reason: "Its thread has an owner."
            })),
            at
          )
        })
      )
    },
    Effect.mapError(failure("route", "Could not route items"))
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

  const move: ConnectionItemStore["Service"]["move"] = Effect.fn("ConnectionItems.move")(
    function* (input) {
      const at = yield* now
      return yield* writer.transact(
        Effect.gen(function* () {
          const notFound = new ConnectionItemStoreError({
            operation: "move",
            reason: "not_found",
            message: "That item is not stored"
          })
          const thread = yield* sql<{ readonly item_id: string }>`SELECT item.item_id
            FROM connection_items AS item JOIN connection_items AS moved
              ON moved.source = item.source AND moved.account = item.account
                AND moved.thread_key = item.thread_key
            WHERE moved.item_id = ${input.itemId}
            ORDER BY item.item_id = ${input.itemId} DESC, item.item_id`
          if (thread.length === 0) return yield* notFound
          let spaceId: string | undefined
          for (const item of thread) {
            const routed = yield* routeItem(sql, {
              itemId: item.item_id,
              spaceId: input.spaceId,
              basis: "user",
              reason: input.reason,
              now: at
            })
            spaceId = routed.spaceId
          }
          const movedIds = JSON.stringify(thread.map((item) => item.item_id))
          yield* sql`UPDATE task_proposals SET status = 'rejected',
              settlement_client_id = 'item_move', settlement_decision = 'reject',
              updated_at = ${at}, settled_at = ${at}
            WHERE place = 'space' AND space_id IS NOT ${spaceId ?? null} AND status = 'offered'
              AND ${citesAny(sql, movedIds)}`
          if (spaceId !== undefined) {
            yield* sql`UPDATE task_proposals SET status = 'rejected', revision = revision + 1,
              settlement_client_id = 'item_move', settlement_decision = 'reject',
              updated_at = ${at}, settled_at = ${at}
              WHERE place = 'home' AND status IN ${openProposalStatusList} AND ${citesAny(sql, movedIds)}`
            yield* openHeldOnHome(sql, at)
            yield* spaceJobs.queueItemsRouted(spaceId, at)
          }
          const rows =
            yield* sql<ItemRow>`SELECT * FROM connection_items WHERE item_id = ${input.itemId}`
          const row = rows[0]
          if (row === undefined) return yield* notFound
          return project(row)
        })
      )
    },
    Effect.mapError(failure("move", "Could not move the item"))
  )

  const report: ConnectionItemStore["Service"]["report"] = Effect.fn("ConnectionItems.report")(
    function* (since) {
      const counts = yield* reader<{
        readonly source: string
        readonly fetched: number
        readonly routed_to_space: number
        readonly routed_home: number
        readonly moved_by_user: number
        readonly pending: number
      }>`SELECT source,
          SUM(fetched_at >= ${since}) AS fetched,
          SUM(routed_at >= ${since} AND owner_space_id IS NOT NULL) AS routed_to_space,
          SUM(routed_at >= ${since} AND owner_space_id IS NULL) AS routed_home,
          SUM(routed_at >= ${since} AND route_basis = 'user') AS moved_by_user,
          SUM(state = 'pending') AS pending
        FROM connection_items GROUP BY source`
      const offers = yield* reader<{
        readonly offered: number | null
        readonly started: number | null
        readonly skipped: number | null
      }>`SELECT SUM(proposal.status = 'offered') AS offered,
          SUM(proposal.status = 'accepted') AS started,
          SUM(proposal.status = 'rejected' AND proposal.settlement_client_id IS NOT 'item_move') AS skipped
        FROM task_proposals AS proposal
        WHERE proposal.place = 'space' AND proposal.created_at >= ${since}
          AND EXISTS (SELECT 1 FROM json_each(proposal.sources_json) AS cited
            WHERE json_extract(cited.value, '$.kind') = 'connection_item')`
      const home = yield* reader<{
        readonly offered: number | null
        readonly held: number | null
        readonly started: number | null
        readonly skipped: number | null
      }>`SELECT SUM(status = 'offered') AS offered, SUM(status = 'held') AS held,
          SUM(status = 'accepted') AS started,
          SUM(status = 'rejected' AND settlement_client_id IS NOT 'item_move') AS skipped
        FROM task_proposals WHERE place = 'home' AND created_at >= ${since}`
      const bySource = new Map(counts.map((row) => [row.source, row]))
      return {
        since,
        sources: [...new Set([...SIGNAL_SOURCE_IDS, ...bySource.keys()])].map((source) => {
          const row = bySource.get(source)
          return {
            source,
            fetched: row?.fetched ?? 0,
            routed_to_space: row?.routed_to_space ?? 0,
            routed_home: row?.routed_home ?? 0,
            moved_by_user: row?.moved_by_user ?? 0,
            pending: row?.pending ?? 0
          }
        }),
        space_offers: {
          offered: offers[0]?.offered ?? 0,
          started: offers[0]?.started ?? 0,
          skipped: offers[0]?.skipped ?? 0
        },
        home_offers: {
          offered: home[0]?.offered ?? 0,
          held: home[0]?.held ?? 0,
          started: home[0]?.started ?? 0,
          skipped: home[0]?.skipped ?? 0
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
    pending,
    routeOwnedThreads,
    route,
    move,
    get,
    availability,
    recent,
    report,
    prune
  })
}
