import type { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../../sessions/events.js"
import type { UnitOfWork } from "../../unit-of-work.js"

interface BackfillChunk {
  readonly converted: number
  readonly next: string | undefined
}

interface BackfillBase {
  readonly name: string
  readonly remaining: Effect.Effect<number, SqlError.SqlError, SqlClient.SqlClient>
}

export interface PreparedBackfill<R = SqlClient.SqlClient> extends BackfillBase {
  readonly prepare: (input: {
    readonly cursor: string | undefined
    readonly limit: number
    readonly reader: SqlClient.SqlClient
  }) => Effect.Effect<Effect.Effect<BackfillChunk, unknown, R>, unknown>
  readonly chunk?: never
}

export interface Backfill<E = SqlError.SqlError, R = SqlClient.SqlClient> extends BackfillBase {
  readonly prepare?: never
  readonly chunk: (input: {
    readonly cursor: string | undefined
    readonly limit: number
  }) => Effect.Effect<BackfillChunk, E, R>
}

export type BackfillContext = SqlClient.SqlClient | SessionLifecycleEvents | UnitOfWork

export type AnyBackfill = Backfill<unknown, BackfillContext> | PreparedBackfill<BackfillContext>

const BACKFILL_NAME = /^[a-z][a-z0-9_]{0,63}$/

export const checkBackfills = (list: ReadonlyArray<AnyBackfill>): ReadonlyArray<AnyBackfill> => {
  const seen = new Set<string>()
  for (const backfill of list) {
    if (!BACKFILL_NAME.test(backfill.name))
      throw new Error(`Backfill name ${JSON.stringify(backfill.name)} is not lower snake case`)
    if (seen.has(backfill.name)) throw new Error(`Backfill ${backfill.name} is declared twice`)
    seen.add(backfill.name)
  }
  return list
}
