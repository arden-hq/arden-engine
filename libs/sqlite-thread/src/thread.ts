import { DatabaseSync, type StatementSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"

// This file imports only node: modules so Node can load it straight from
// source under tests (type stripping) as well as from the build.

/** What the client passes when it starts the thread. */
export interface SqliteThreadOptions {
  readonly filename: string
  readonly readonly: boolean
  readonly busyTimeoutMs: number
  readonly wal: boolean
  readonly prepareCacheSize: number
}

/** How a statement's rows come back: objects, or arrays of column values. */
export type SqliteThreadShape = "objects" | "values"

export interface SqliteThreadRequest {
  readonly id: number
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
  readonly shape: SqliteThreadShape
  /** Prepared statements are cached by their text; unprepared ones are not. */
  readonly prepared: boolean
  /** A statement with no result columns reports its changes instead of rows. */
  readonly raw: boolean
  readonly safeIntegers: boolean
}

interface SqliteThreadError {
  readonly message: string
  readonly code: unknown
  readonly errcode: unknown
  readonly errstr: unknown
}

export type SqliteThreadReply =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: SqliteThreadError }

const port = parentPort
if (port === null) throw new Error("The SQLite thread must run in a worker thread")
const options = workerData as SqliteThreadOptions

// Switching a new file to WAL needs a lock that SQLite does not always wait
// for, so two connections opening the same new file at once can fail the
// switch with "database is locked" whatever busy_timeout says. WAL is stored
// in the file: skip the switch when it is already set, and retry it briefly
// while another connection is making it. A read-only connection never switches.
const WAL_RETRY_MS = 5_000
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
const isBusy = (cause: unknown): boolean => {
  const errcode = (cause as { readonly errcode?: unknown } | null)?.errcode
  return typeof errcode === "number" && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6)
}
const enableWal = (connection: DatabaseSync): void => {
  const deadline = Date.now() + WAL_RETRY_MS
  for (;;) {
    try {
      const mode = connection.prepare("PRAGMA journal_mode").get()?.journal_mode
      if (mode === "wal") return
      connection.exec("PRAGMA journal_mode = WAL")
      return
    } catch (cause) {
      if (!isBusy(cause) || Date.now() >= deadline) throw cause
      sleep(10)
    }
  }
}

const database = new DatabaseSync(options.filename, {
  readOnly: options.readonly,
  allowExtension: false
})
database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`)
if (options.wal && !options.readonly) enableWal(database)

const statements = new Map<string, StatementSync>()
const prepare = (sql: string): StatementSync => {
  const cached = statements.get(sql)
  if (cached !== undefined) {
    statements.delete(sql)
    statements.set(sql, cached)
    return cached
  }
  const statement = database.prepare(sql)
  statements.set(sql, statement)
  if (statements.size > options.prepareCacheSize) {
    const oldest = statements.keys().next()
    if (oldest.done !== true) statements.delete(oldest.value)
  }
  return statement
}

const run = (request: SqliteThreadRequest): unknown => {
  const statement = request.prepared ? prepare(request.sql) : database.prepare(request.sql)
  const params = request.params as Array<never>
  statement.setReadBigInts(request.safeIntegers)
  statement.setReturnArrays(request.shape === "values")
  try {
    if (statement.columns().length > 0) return statement.all(...params)
    const result = statement.run(...params)
    return request.raw ? { changes: result.changes, lastInsertRowid: result.lastInsertRowid } : []
  } finally {
    statement.setReturnArrays(false)
  }
}

const errorOf = (cause: unknown): SqliteThreadError => {
  const fields =
    typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : {}
  return {
    // oxlint-disable-next-line arden/restricted-syntax -- this thread imports only node: modules, so it cannot use the shared helper
    message: cause instanceof Error ? cause.message : String(cause),
    code: fields.code,
    errcode: fields.errcode,
    errstr: fields.errstr
  }
}

port.on("message", (message: SqliteThreadRequest | "close") => {
  if (message === "close") {
    database.close()
    port.close()
    return
  }
  let reply: SqliteThreadReply
  try {
    reply = { id: message.id, ok: true, result: run(message) }
  } catch (cause) {
    reply = { id: message.id, ok: false, error: errorOf(cause) }
  }
  port.postMessage(reply)
})
