import { Context, Duration, Effect, Scope, Semaphore, Stream } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { SqlClient, SqlError, Statement } from "effect/unstable/sql"
import type { SqlConnection } from "effect/unstable/sql"
import { Worker } from "node:worker_threads"

import type {
  SqliteThreadOptions,
  SqliteThreadReply,
  SqliteThreadRequest,
  SqliteThreadShape
} from "./thread.js"

const MAX_BUSY_TIMEOUT = 2_147_483_647

export interface SqliteThreadClientConfig {
  readonly filename: string
  readonly readonly?: boolean
  /** How long SQLite waits on a lock; it blocks only the connection's thread. Defaults to 5 seconds. */
  readonly busyTimeout?: Duration.Input
  /** Keep the file's rollback journal instead of switching it to WAL. */
  readonly disableWAL?: boolean
  /** Read-only connections, each on its own thread, that serve statements in
   *  parallel: one slow read no longer queues every other behind it. Only for
   *  a `readonly` client; a writer keeps its one serialized connection.
   *  Defaults to 1. */
  readonly connections?: number
}

const threadUrl = new URL(
  import.meta.url.endsWith(".ts") ? "./thread.ts" : "./thread.js",
  import.meta.url
)

const failure = (cause: unknown, operation: string): SqlError.SqlError =>
  new SqlError.SqlError({
    reason: SqlError.classifySqliteError(cause, {
      message: "Failed to execute statement",
      operation
    })
  })

/** node:sqlite reports the SQLite result code as `errcode`; classification reads `errno`. */
const causeOf = (error: Extract<SqliteThreadReply, { ok: false }>["error"]): unknown =>
  Object.assign(new Error(error.message), {
    code: error.code,
    errcode: error.errcode,
    errstr: error.errstr,
    ...(typeof error.errcode === "number" ? { errno: error.errcode } : {})
  })

interface Lane {
  readonly connection: SqlConnection.Connection
  readonly waiting: () => number
  readonly permit: Semaphore.Semaphore
  held: boolean
}

const openLane = Effect.fn("SqliteThread.openLane")(function* (
  options: SqliteThreadOptions
): Effect.fn.Return<Lane, never, Scope.Scope> {
  const pending = new Map<number, (result: Effect.Effect<unknown, SqlError.SqlError>) => void>()
  let nextId = 0
  let gone: SqlError.SqlError | undefined
  const worker = new Worker(threadUrl, { workerData: options })
  worker.unref()
  const settleAll = (error: SqlError.SqlError) => {
    gone ??= error
    const waiting = [...pending.values()]
    pending.clear()
    for (const resume of waiting) resume(Effect.fail(error))
  }
  worker.on("message", (reply: SqliteThreadReply) => {
    const resume = pending.get(reply.id)
    if (resume === undefined) return
    pending.delete(reply.id)
    if (pending.size === 0) worker.unref()
    resume(
      reply.ok
        ? Effect.succeed(reply.result)
        : Effect.fail(failure(causeOf(reply.error), "execute"))
    )
  })
  worker.on("error", (cause) =>
    settleAll(
      new SqlError.SqlError({
        reason: new SqlError.ConnectionError({ cause, message: "The SQLite thread failed" })
      })
    )
  )
  worker.on("exit", (exitCode) =>
    settleAll(
      new SqlError.SqlError({
        reason: new SqlError.ConnectionError({
          cause: exitCode,
          message: `The SQLite thread exited (${exitCode})`
        })
      })
    )
  )
  yield* Effect.addFinalizer(() =>
    Effect.callback<void>((resume) => {
      if (gone !== undefined) return resume(Effect.void)
      worker.once("exit", () => resume(Effect.void))
      worker.postMessage("close")
    })
  )

  const send = (
    sql: string,
    params: ReadonlyArray<unknown>,
    request: Pick<SqliteThreadRequest, "shape" | "prepared" | "raw">
  ): Effect.Effect<unknown, SqlError.SqlError> =>
    Effect.withFiber((fiber) => {
      const safeIntegers = Context.get(fiber.context, SqlClient.SafeIntegers)
      return Effect.callback<unknown, SqlError.SqlError>((resume) => {
        if (gone !== undefined) return resume(Effect.fail(gone))
        const id = nextId++
        if (pending.size === 0) worker.ref()
        pending.set(id, resume)
        worker.postMessage({
          id,
          sql,
          params,
          safeIntegers,
          ...request
        } satisfies SqliteThreadRequest)
      })
    })

  const rows =
    (shape: SqliteThreadShape, prepared: boolean) =>
    (sql: string, params: ReadonlyArray<unknown>) =>
      send(sql, params, { shape, prepared, raw: false }) as Effect.Effect<
        ReadonlyArray<never>,
        SqlError.SqlError
      >

  const connection: SqlConnection.Connection = {
    execute: (sql, params, transformRows) => {
      const effect = rows("objects", true)(sql, params)
      return transformRows ? Effect.map(effect, transformRows) : effect
    },
    executeRaw: (sql, params) => send(sql, params, { shape: "objects", prepared: true, raw: true }),
    executeValues: rows("values", true),
    executeValuesUnprepared: rows("values", false),
    executeUnprepared: (sql, params, transformRows) => {
      const effect = rows("objects", false)(sql, params ?? [])
      return transformRows ? Effect.map(effect, transformRows) : effect
    },
    executeStream: () => Stream.die("executeStream not implemented")
  }

  return { connection, waiting: () => pending.size, permit: yield* Semaphore.make(1), held: false }
})

/**
 * A SQL client whose connections live on worker threads. It keeps the
 * contract of `@effect/sql-sqlite-node`'s client (a serialized connection,
 * `BEGIN IMMEDIATE` transactions, the same error classification), but every
 * statement is asynchronous for the server: a slow query or a lock wait stalls
 * the connection's thread, not the caller's event loop. A read-only client may
 * open several connections (`connections`); a statement goes to the least busy
 * one, and a transaction keeps its connection to itself until it ends.
 */
export const makeSqliteThreadClient = Effect.fn("makeSqliteThreadClient")(function* (
  config: SqliteThreadClientConfig
): Effect.fn.Return<SqlClient.SqlClient, never, Scope.Scope | Reactivity.Reactivity> {
  const options: SqliteThreadOptions = {
    filename: config.filename,
    readonly: config.readonly ?? false,
    busyTimeoutMs: Math.min(
      MAX_BUSY_TIMEOUT,
      Math.max(0, Math.round(Duration.toMillis(config.busyTimeout ?? Duration.seconds(5))))
    ),
    wal: config.disableWAL !== true,
    prepareCacheSize: 200
  }
  const count = config.readonly === true ? Math.max(1, Math.floor(config.connections ?? 1)) : 1
  const lanes: Array<Lane> = []
  for (let i = 0; i < count; i++) lanes.push(yield* openLane(options))
  const load = (lane: Lane) => (lane.held ? Number.MAX_SAFE_INTEGER : lane.waiting())
  const pick = (): Lane => lanes.reduce((best, lane) => (load(lane) < load(best) ? lane : best))

  const acquirer = Effect.suspend(() => {
    const lane = pick()
    return lane.permit.withPermits(1)(Effect.succeed(lane.connection))
  })
  const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.scope, (scope) => {
      const lane = pick()
      return Effect.as(
        Effect.tap(restore(lane.permit.take(1)), () => {
          lane.held = true
          return Scope.addFinalizer(
            scope,
            Effect.andThen(
              Effect.sync(() => {
                lane.held = false
              }),
              lane.permit.release(1)
            )
          )
        }),
        lane.connection
      )
    })
  )
  return yield* SqlClient.make({
    acquirer,
    compiler: Statement.makeCompilerSqlite(),
    transactionAcquirer,
    beginTransaction: "BEGIN IMMEDIATE",
    spanAttributes: [["db.system.name", "sqlite"]]
  })
})
