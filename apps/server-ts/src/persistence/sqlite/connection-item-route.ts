import { cutText } from "@arden-hq/std/text"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { RouteBasis } from "../connections/store.js"
import { ConnectionItemStoreError } from "../connections/store.js"

const failure = (
  reason: ConnectionItemStoreError["reason"],
  message: string,
  cause?: unknown
): ConnectionItemStoreError =>
  new ConnectionItemStoreError({
    operation: "route",
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export interface RoutedItem {
  readonly spaceId: string | undefined
  readonly basis: RouteBasis
  readonly reason: string
  readonly previousSpaceId: string | undefined
  readonly changed: boolean
}

export const routeItem = Effect.fn("ConnectionItems.routeItem")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly itemId: string
    readonly spaceId: string | undefined
    readonly basis: RouteBasis
    readonly reason: string
    readonly now: string
  }
): Effect.fn.Return<RoutedItem, ConnectionItemStoreError> {
  const query = <A>(effect: Effect.Effect<A, unknown>) =>
    effect.pipe(Effect.mapError((cause) => failure("storage", "Could not route the item", cause)))
  const items = yield* query(
    sql<{
      readonly source: string
      readonly account: string
      readonly thread_key: string
      readonly state: string
      readonly owner_space_id: string | null
      readonly route_basis: RouteBasis | null
      readonly route_reason: string | null
    }>`SELECT source, account, thread_key, state, owner_space_id, route_basis, route_reason
      FROM connection_items WHERE item_id = ${input.itemId}`
  )
  const item = items[0]
  if (item === undefined)
    return yield* failure("not_found", "That item is not stored (it may have expired)")
  const byUser = input.basis === "user"
  if (item.state === "routed" && !byUser)
    return {
      spaceId: item.owner_space_id ?? undefined,
      basis: item.route_basis ?? "home",
      reason: item.route_reason ?? "",
      previousSpaceId: item.owner_space_id ?? undefined,
      changed: false
    }
  const owners = byUser
    ? []
    : yield* query(
        sql<{
          readonly owner_space_id: string | null
          readonly basis: string
        }>`SELECT owner_space_id, basis FROM connection_threads
          WHERE source = ${item.source} AND account = ${item.account}
            AND thread_key = ${item.thread_key}`
      )
  const owner = owners[0]
  const wanted =
    owner === undefined
      ? { spaceId: input.spaceId, basis: input.basis, reason: input.reason }
      : {
          spaceId: owner.owner_space_id ?? undefined,
          basis: "thread" as const,
          reason:
            owner.basis === "user"
              ? "Its thread follows the move you made."
              : "Earlier items in its thread went here."
        }
  const active =
    wanted.spaceId === undefined
      ? []
      : yield* query(
          sql`SELECT 1 FROM spaces WHERE space_id = ${wanted.spaceId}
            AND archived_at IS NULL`
        )
  if (wanted.spaceId !== undefined && active.length === 0 && byUser)
    return yield* failure("invalid", "That Space is archived; name an active Space or Home")
  const route =
    wanted.spaceId !== undefined && active.length === 0
      ? { spaceId: undefined, basis: "home" as const, reason: "Its Space is archived." }
      : wanted
  const reason = cutText(route.reason.trim() || "No reason given.", 500)
  yield* query(
    sql`UPDATE connection_items SET state = 'routed', owner_space_id = ${route.spaceId ?? null},
      route_basis = ${route.basis}, route_reason = ${reason}, routed_at = ${input.now}
      WHERE item_id = ${input.itemId}`
  )
  if (byUser)
    yield* query(
      sql`INSERT INTO connection_threads (source, account, thread_key, owner_space_id, basis, updated_at)
        VALUES (${item.source}, ${item.account}, ${item.thread_key}, ${route.spaceId ?? null}, 'user', ${input.now})
        ON CONFLICT(source, account, thread_key) DO UPDATE SET owner_space_id = excluded.owner_space_id,
          basis = 'user', updated_at = excluded.updated_at`
    )
  else if (owner === undefined && route.spaceId !== undefined)
    yield* query(
      sql`INSERT INTO connection_threads (source, account, thread_key, owner_space_id, basis, updated_at)
        VALUES (${item.source}, ${item.account}, ${item.thread_key}, ${route.spaceId}, 'router', ${input.now})
        ON CONFLICT(source, account, thread_key) DO NOTHING`
    )
  return {
    spaceId: route.spaceId,
    basis: route.basis,
    reason,
    previousSpaceId: item.owner_space_id ?? undefined,
    changed: true
  }
})
