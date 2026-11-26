import { randomUUID } from "node:crypto"
import { Context, Effect, Option, Semaphore } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import type { ChatEventStore } from "../events/store.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import type { PersistenceWriteQueue } from "../write-queue.js"
import type { DiagnosticsService } from "../../runtime/diagnostics.js"
import { makeUnitOfWork, UnitOfWork } from "../unit-of-work.js"
import {
  ToolResultObjects,
  type ToolResultObjectStore
} from "../managed-output/tool-result-objects.js"

export const IdGenerator = Context.Reference<{ readonly next: () => string }>(
  "@arden-hq/server/persistence/IdGenerator",
  { defaultValue: () => ({ next: randomUUID }) }
)

export const nextId: Effect.Effect<string> = Effect.service(IdGenerator).pipe(
  Effect.map((ids) => ids.next())
)

type Transact = <A, E>(
  effect: Effect.Effect<A, E, UnitOfWork>
) => Effect.Effect<A, E | SqlError.SqlError>

/** Read-only connections the server opens beside the writer, each on its own thread. */
export const READER_CONNECTIONS = 4

// A snapshot keeps one reader connection to itself until its transaction ends
// (`@arden-hq/sqlite-thread` pins the lane). At most half of them at once, so
// a burst of chat opens or other snapshots leaves two connections for every
// other read instead of queueing lists and history behind pinned lanes.
const SNAPSHOT_CONCURRENCY = READER_CONNECTIONS / 2

export interface Writer {
  readonly sql: SqlClient.SqlClient
  readonly reader: SqlClient.SqlClient
  readonly transact: Transact
  readonly transactInteractive: Transact
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly waiting: Effect.Effect<number>
  readonly snapshot: <A, E>(read: Effect.Effect<A, E>) => Effect.Effect<A, E | SqlError.SqlError>
  /** Gives `effect` the store that keeps large tool results; transactions and snapshots have it already. */
  readonly withToolResults: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export interface PersistenceDeps {
  readonly writer: Writer
  readonly reader: SqlClient.SqlClient
  readonly chatEvents: ChatEventStore["Service"]
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly diagnostics: DiagnosticsService
}

export type WriterDeps = Pick<PersistenceDeps, "writer">

export const makeWriter = (options: {
  readonly sql: SqlClient.SqlClient
  readonly reader: SqlClient.SqlClient
  readonly queue: PersistenceWriteQueue["Service"]
  readonly beforeCommit?: () => Effect.Effect<void, never, UnitOfWork> | undefined
  readonly toolResults?: () => ToolResultObjectStore | undefined
}): Writer => {
  const { sql, reader, queue } = options
  const snapshots = Semaphore.makeUnsafe(SNAPSHOT_CONCURRENCY)
  const withToolResults: Writer["withToolResults"] = (effect) =>
    Effect.suspend(() => Effect.provideService(effect, ToolResultObjects, options.toolResults?.()))
  const unitOfWork: Transact = (effect) =>
    Effect.suspend(() => {
      const committed: Array<Effect.Effect<void>> = []
      const unit = makeUnitOfWork((notify) =>
        Effect.sync(() => {
          committed.push(notify)
        })
      )
      const beforeCommit = options.beforeCommit?.()
      const changes = sql<{ readonly n: number }>`SELECT total_changes() AS n`.pipe(
        Effect.map((rows) => rows[0]?.n ?? 0)
      )
      const write =
        beforeCommit === undefined
          ? effect
          : Effect.gen(function* () {
              const before = yield* changes
              const result = yield* effect
              if ((yield* changes) !== before) yield* beforeCommit
              return result
            })
      return sql
        .withTransaction(withToolResults(Effect.provideService(write, UnitOfWork, unit)))
        .pipe(Effect.tap(() => Effect.forEach(committed, (notify) => notify, { discard: true })))
    })
  return {
    sql,
    reader,
    transact: (effect) => queue.run(unitOfWork(effect)),
    transactInteractive: (effect) => queue.runInteractive(unitOfWork(effect)),
    run: queue.run,
    waiting: queue.waiting,
    // A snapshot inside another one joins its transaction and needs no second permit.
    snapshot: (read) =>
      Effect.serviceOption(reader.transactionService).pipe(
        Effect.flatMap((open) =>
          Option.isSome(open)
            ? reader.withTransaction(withToolResults(read))
            : snapshots.withPermit(reader.withTransaction(withToolResults(read)))
        )
      ),
    withToolResults
  }
}
