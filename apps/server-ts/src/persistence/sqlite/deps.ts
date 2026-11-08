import { randomUUID } from "node:crypto"
import { Context, Effect } from "effect"
import type { SqlClient, SqlError } from "effect/unstable/sql"
import type { ChatEventStore } from "../events/store.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import type { PersistenceWriteQueue } from "../write-queue.js"
import type { DiagnosticsService } from "../../runtime/diagnostics.js"
import { makeUnitOfWork, UnitOfWork } from "../unit-of-work.js"

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

export interface Writer {
  readonly sql: SqlClient.SqlClient
  readonly reader: SqlClient.SqlClient
  readonly transact: Transact
  readonly transactInteractive: Transact
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly snapshot: <A, E>(read: Effect.Effect<A, E>) => Effect.Effect<A, E | SqlError.SqlError>
}

export interface PersistenceDeps {
  readonly writer: Writer
  readonly reader: SqlClient.SqlClient
  readonly chatEvents: ChatEventStore["Service"]
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly diagnostics: DiagnosticsService
}

export const makeWriter = (options: {
  readonly sql: SqlClient.SqlClient
  readonly reader: SqlClient.SqlClient
  readonly queue: PersistenceWriteQueue["Service"]
  readonly beforeCommit?: () => Effect.Effect<void, never, UnitOfWork> | undefined
}): Writer => {
  const { sql, reader, queue } = options
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
        .withTransaction(Effect.provideService(write, UnitOfWork, unit))
        .pipe(Effect.tap(() => Effect.forEach(committed, (notify) => notify, { discard: true })))
    })
  return {
    sql,
    reader,
    transact: (effect) => queue.run(unitOfWork(effect)),
    transactInteractive: (effect) => queue.runInteractive(unitOfWork(effect)),
    run: queue.run,
    snapshot: (read) => reader.withTransaction(read)
  }
}
