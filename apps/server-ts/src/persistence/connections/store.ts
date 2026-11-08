import type { SignalSource } from "@arden-hq/protocol/signals"
import { Context, Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"

export type ConnectionSource = SignalSource

export type RouteBasis = "thread" | "router" | "home" | "user"

export interface FetchedConnectionItem {
  readonly source: ConnectionSource
  readonly account: string
  readonly externalId: string
  readonly threadKey: string
  readonly title: string
  readonly sender: string | undefined
  readonly receivedAt: string
  readonly snippet: string
}

type ConnectionItemRoute =
  | { readonly kind: "pending" }
  | {
      readonly kind: "routed"
      readonly spaceId: string | undefined
      readonly basis: RouteBasis
      readonly reason: string
      readonly routedAt: string
    }

export interface ConnectionItem extends Omit<FetchedConnectionItem, "source"> {
  readonly source: string
  readonly itemId: string
  readonly fetchedAt: string
  readonly route: ConnectionItemRoute
}

export type ConnectionItemAvailability =
  | { readonly kind: "available"; readonly item: ConnectionItem }
  | { readonly kind: "expired" }
  | { readonly kind: "unknown" }

export interface RouteDecision {
  readonly itemId: string
  readonly spaceId: string | undefined
  readonly basis: Exclude<RouteBasis, "user">
  readonly reason: string
}

export const CONNECTION_ITEM_KEEP_DAYS = 30

export interface ConnectionCursor {
  readonly cursor: string | undefined
  readonly pollAfter: string | undefined
  readonly since: string | undefined
}

export interface ConnectionItemsReport {
  readonly since: string
  readonly sources: ReadonlyArray<{
    readonly source: string
    readonly fetched: number
    readonly routed_to_space: number
    readonly routed_home: number
    readonly moved_by_user: number
    readonly pending: number
  }>
  readonly space_offers: {
    readonly offered: number
    readonly started: number
    readonly skipped: number
  }
  readonly home_offers: {
    readonly offered: number
    readonly held: number
    readonly started: number
    readonly skipped: number
  }
}

export class ConnectionItemStoreError extends Schema.TaggedError<ConnectionItemStoreError>()(
  "ConnectionItemStoreError",
  {
    ...storeErrorFields({
      operations: ["cursor", "fetch", "read", "route", "move", "report", "prune"],
      reasons: ["invalid", "not_found", "conflict", "storage"]
    })
  }
) {}

type Result<A> = Effect.Effect<A, ConnectionItemStoreError>

export class ConnectionItemStore extends Context.Service<
  ConnectionItemStore,
  {
    readonly cursor: (
      source: ConnectionSource,
      account: string
    ) => Result<ConnectionCursor | undefined>
    readonly threadOwned: (input: {
      readonly source: ConnectionSource
      readonly account: string
      readonly threadKey: string
    }) => Result<boolean>
    readonly saveFetch: (input: {
      readonly source: ConnectionSource
      readonly account: string
      readonly cursor: string | undefined
      readonly pollAfter: string | undefined
      readonly since: string | undefined
      readonly items: ReadonlyArray<FetchedConnectionItem>
    }) => Result<{ readonly inserted: number }>
    readonly pending: (limit: number) => Result<ReadonlyArray<ConnectionItem>>
    readonly routeOwnedThreads: () => Result<void>
    readonly route: (decisions: ReadonlyArray<RouteDecision>) => Result<void>
    readonly move: (input: {
      readonly itemId: string
      readonly spaceId: string | undefined
      readonly reason: string
    }) => Result<ConnectionItem>
    readonly get: (itemId: string) => Result<ConnectionItem | undefined>
    readonly availability: (itemId: string) => Result<ConnectionItemAvailability>
    readonly recent: (since: string, limit: number) => Result<ReadonlyArray<ConnectionItem>>
    readonly report: (since: string) => Result<ConnectionItemsReport>
    readonly prune: (before: string) => Result<number>
  }
>()("@arden-hq/server/persistence/connections/ConnectionItemStore") {}
