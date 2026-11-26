import type { JsonValue } from "@arden-hq/protocol"
import type { SignalSource } from "@arden-hq/protocol/signals"
import { Context, Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"

export type ConnectionSource = SignalSource

export interface FetchedConnectionItem {
  readonly source: ConnectionSource
  readonly account: string
  readonly externalId: string
  readonly threadKey: string
  readonly title: string
  readonly sender: string | undefined
  readonly receivedAt: string
  readonly snippet: string
  readonly detail: ConnectionItemDetail | undefined
}

export type ConnectionItemDetail = Readonly<Record<string, JsonValue>>

export interface ConnectionItem extends Omit<FetchedConnectionItem, "source"> {
  readonly source: string
  readonly itemId: string
  readonly fetchedAt: string
}

export type ConnectionItemAvailability =
  | { readonly kind: "available"; readonly item: ConnectionItem }
  | { readonly kind: "expired" }
  | { readonly kind: "unknown" }

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
  }>
  readonly offers: {
    readonly offered: number
    readonly started: number
    readonly skipped: number
  }
}

export class ConnectionItemStoreError extends Schema.TaggedError<ConnectionItemStoreError>()(
  "ConnectionItemStoreError",
  {
    ...storeErrorFields({
      operations: ["cursor", "fetch", "read", "report", "prune"],
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
    readonly get: (itemId: string) => Result<ConnectionItem | undefined>
    readonly availability: (itemId: string) => Result<ConnectionItemAvailability>
    readonly recent: (since: string, limit: number) => Result<ReadonlyArray<ConnectionItem>>
    readonly report: (since: string) => Result<ConnectionItemsReport>
    readonly prune: (before: string) => Result<number>
  }
>()("@arden-hq/server/persistence/connections/ConnectionItemStore") {}
