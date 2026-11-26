import { appendFileSync } from "node:fs"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { parentPort, threadId, workerData } from "node:worker_threads"

export interface SqliteThreadOptions {
  readonly filename: string
  readonly readonly: boolean
  readonly busyTimeoutMs: number
  readonly wal: boolean
  readonly prepareCacheSize: number
}

const SQLITE_THREAD_SHAPE = { objects: "objects", values: "values" } as const
export type SqliteThreadShape = (typeof SQLITE_THREAD_SHAPE)[keyof typeof SQLITE_THREAD_SHAPE]

const CLOSE_MESSAGE = "close"

export interface SqliteThreadRequest {
  readonly id: number
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
  readonly shape: SqliteThreadShape
  readonly prepared: boolean
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

const WAL_RETRY_MS = 5_000
const WAL_JOURNAL_MODE = "wal"
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
      if (mode === WAL_JOURNAL_MODE) return
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

const scanLog = process.env.ARDEN_SQL_SCAN_LOG
const planned = new Set<string>()
const SCAN_STEP = /^SCAN (\S+)(?: USING (?:COVERING )?INDEX (\S+))?/
const noteScans = (sql: string): void => {
  if (scanLog === undefined || scanLog.length === 0 || planned.has(sql)) return
  planned.add(sql)
  try {
    const steps = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
    for (const step of steps) {
      const detail = String(step.detail)
      const scan = SCAN_STEP.exec(detail)
      if (scan === null) continue
      const index = scan[2]
      const owner =
        index === undefined
          ? undefined
          : database.prepare("SELECT tbl_name, sql FROM sqlite_schema WHERE name = ?").get(index)
      appendFileSync(
        `${scanLog}/${process.pid}-${threadId}.jsonl`,
        `${JSON.stringify({
          name: scan[1],
          table: owner?.tbl_name,
          index,
          partial: typeof owner?.sql === "string" && /\sWHERE\s/i.test(owner.sql),
          detail,
          sql
        })}\n`
      )
    }
  } catch {}
}

const slowLog = process.env.ARDEN_SQL_SLOW_LOG
const slowFloor = process.env.ARDEN_SQL_SLOW_MS
const DEFAULT_SLOW_STATEMENT_MS = 50
const SLOW_STATEMENT_MS =
  slowFloor === undefined || slowFloor === "" || !(Number(slowFloor) >= 0)
    ? DEFAULT_SLOW_STATEMENT_MS
    : Number(slowFloor)
const run = (request: SqliteThreadRequest): unknown => {
  noteScans(request.sql)
  if (slowLog === undefined || slowLog.length === 0) return runStatement(request)
  const started = performance.now()
  try {
    return runStatement(request)
  } finally {
    const ms = performance.now() - started
    if (ms >= SLOW_STATEMENT_MS)
      appendFileSync(
        `${slowLog}/slow-${process.pid}-${threadId}.jsonl`,
        `${JSON.stringify({ at: new Date().toISOString(), ms: Math.round(ms * 10) / 10, sql: request.sql })}\n`
      )
  }
}

const runStatement = (request: SqliteThreadRequest): unknown => {
  const statement = request.prepared ? prepare(request.sql) : database.prepare(request.sql)
  const params = request.params as Array<never>
  statement.setReadBigInts(request.safeIntegers)
  statement.setReturnArrays(request.shape === SQLITE_THREAD_SHAPE.values)
  try {
    if (statement.columns().length > 0) return statement.all(...params)
    if (!request.raw) {
      statement.all(...params)
      return []
    }
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

port.on("message", (message: SqliteThreadRequest | typeof CLOSE_MESSAGE) => {
  if (message === CLOSE_MESSAGE) {
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
