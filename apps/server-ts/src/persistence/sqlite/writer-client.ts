import { Context, Duration, Effect, Layer, Schedule, Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql"
import { Reactivity } from "effect/unstable/reactivity"
import { makeSqliteThreadClient, type SqliteThreadClientConfig } from "@arden-hq/sqlite-thread"

const savepointName = (id: number) => `effect_sql_${String(id)}`

/**
 * SQLite keeps a transaction open when its COMMIT fails. That happens when
 * another process holds a read lock on a rollback-journal database the
 * transaction wrote: the attached search.sqlite. Effect's transaction wrapper
 * turns the failed COMMIT into a defect and never rolls back, so every later
 * BEGIN on the connection fails ("cannot start a transaction within a
 * transaction") until restart. Here a failed COMMIT rolls back first: that
 * transaction's writes are lost and it still fails, but the connection works.
 */
const rollbackOnFailedCommit = <C extends SqlClient.SqlClient>(client: C, retries: number): C => {
  const waitForLock = <A>(operation: Effect.Effect<A, SqlError.SqlError>) =>
    operation.pipe(
      Effect.retry({
        while: (error) => error.reason._tag === "LockTimeoutError",
        times: retries,
        schedule: Schedule.spaced("25 millis")
      })
    )
  return Object.assign(client, {
    withTransaction: SqlClient.makeWithTransaction({
      transactionService: client.transactionService,
      spanAttributes: [["db.system.name", "sqlite"]],
      acquireConnection: Effect.flatMap(Scope.make(), (scope) =>
        Effect.map(Scope.provide(client.reserve, scope), (conn) => [scope, conn] as const)
      ),
      begin: (conn) =>
        Effect.asVoid(waitForLock(conn.executeUnprepared("BEGIN IMMEDIATE", [], undefined))),
      savepoint: (conn, id) =>
        Effect.asVoid(conn.executeUnprepared(`SAVEPOINT ${savepointName(id)}`, [], undefined)),
      commit: (conn) =>
        waitForLock(conn.executeUnprepared("COMMIT", [], undefined)).pipe(
          Effect.asVoid,
          Effect.tapError(() => Effect.ignore(conn.executeUnprepared("ROLLBACK", [], undefined)))
        ),
      rollback: (conn) => Effect.asVoid(conn.executeUnprepared("ROLLBACK", [], undefined)),
      rollbackSavepoint: (conn, id) =>
        Effect.asVoid(
          conn.executeUnprepared(`ROLLBACK TO SAVEPOINT ${savepointName(id)}`, [], undefined)
        )
    })
  })
}

export const sqliteWriterLayer = (config: SqliteThreadClientConfig) =>
  Layer.effectContext(
    Effect.map(makeSqliteThreadClient({ ...config, busyTimeout: 0 }), (client) => {
      const retries = Math.ceil(
        Math.min(2_147_483_647, Math.max(0, Duration.toMillis(config.busyTimeout ?? "5 seconds"))) /
          25
      )
      const writer = rollbackOnFailedCommit(client, retries)
      return Context.make(SqlClient.SqlClient, writer)
    })
  ).pipe(Layer.provide(Reactivity.layer))
