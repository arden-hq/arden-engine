#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs"
import { isAbsolute, resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { databaseSchema } from "../dist/persistence/schema/database.js"
import { searchSchemaSection } from "../dist/persistence/schema/search.js"
import { initializeSearchIndex } from "../dist/persistence/sqlite/search.js"
import { errorMessage } from "@arden-hq/std/errors"

const usage = `Usage:
  storage-maintenance.mjs storage check --data-root <absolute-path> --confirm-stopped
  storage-maintenance.mjs search rebuild --data-root <absolute-path> --confirm-stopped

Both commands require macOS lsof, stopped Arden and other SQLite clients, and checkpointed WAL files.`
const manifestSql =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name"

const immutableUri = (filename) => {
  const uri = pathToFileURL(filename)
  uri.searchParams.set("mode", "ro")
  uri.searchParams.set("immutable", "1")
  return uri.href
}
const openImmutable = (filename) => new DatabaseSync(immutableUri(filename), { readOnly: true })

const requireFile = (filename, optional = false) => {
  if (!existsSync(filename)) {
    if (optional) return false
    throw new Error(`Required storage file is absent: ${filename}`)
  }
  const entry = lstatSync(filename)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Unsafe storage file: ${filename}`)
  return true
}

const pathsFor = (dataRoot) => {
  if (!dataRoot || !isAbsolute(dataRoot) || dataRoot !== resolve(dataRoot)) {
    throw new Error("--data-root must be an explicit absolute canonical path")
  }
  if (
    !existsSync(dataRoot) ||
    !lstatSync(dataRoot).isDirectory() ||
    realpathSync(dataRoot) !== dataRoot
  ) {
    throw new Error("--data-root must be a real directory without symlinked ancestors")
  }
  const operational = join(dataRoot, "arden.db")
  const search = join(dataRoot, "search.sqlite")
  requireFile(operational)
  requireFile(search, true)
  for (const filename of [operational, search]) {
    for (const suffix of ["-wal", "-shm"]) requireFile(filename + suffix, true)
  }
  return { operational, search }
}

const assertNoWalBytes = (filenames) => {
  for (const filename of filenames) {
    const wal = `${filename}-wal`
    if (existsSync(wal) && statSync(wal).size > 0) {
      throw new Error(
        `Nonempty WAL requires stopped, checkpointed storage before this command: ${wal}`
      )
    }
  }
}

const currentSchema = () => {
  const memory = new DatabaseSync(":memory:")
  try {
    for (const statement of databaseSchema.statements) memory.exec(statement)
    return memory
      .prepare(manifestSql)
      .all()
      .map(({ type, name, tbl_name, sql }) => [type, name, tbl_name, sql])
  } finally {
    memory.close()
  }
}

const checkOperational = (database) => {
  if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
    throw new Error("Operational SQLite integrity check failed")
  }
  if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
    throw new Error("Operational SQLite foreign key check failed")
  }
  const live = database
    .prepare(manifestSql)
    .all()
    .map(({ type, name, tbl_name, sql }) => [type, name, tbl_name, sql])
  if (JSON.stringify(live) !== JSON.stringify(currentSchema())) {
    throw new Error("Operational SQLite schema differs from the current declared schema")
  }
  const source = database
    .prepare("SELECT source_id FROM transcript_search_source WHERE singleton_id=1")
    .get()
  const clock = database
    .prepare("SELECT head_sequence FROM transcript_search_clock WHERE singleton_id=1")
    .get()
  if (typeof source?.source_id !== "string" || typeof clock?.head_sequence !== "number") {
    throw new Error("Operational search source or clock is missing")
  }
  return {
    sourceId: source.source_id,
    head: clock.head_sequence,
    messages: database.prepare("SELECT count(*) AS n FROM session_messages").get().n,
    pendingChanges: database.prepare("SELECT count(*) AS n FROM transcript_search_changes").get().n,
    schemaObjects: live.length
  }
}

const checkDerived = (database, source) => {
  const version = database.prepare("PRAGMA search.user_version").get()?.user_version
  if (version !== searchSchemaSection.version)
    throw new Error("Derived search schema version is not current")
  if (database.prepare("PRAGMA search.integrity_check").get()?.integrity_check !== "ok") {
    throw new Error("Derived search SQLite integrity check failed")
  }
  const cursor = database
    .prepare("SELECT applied_sequence,source_id FROM search.transcript_cursor WHERE singleton_id=1")
    .get()
  if (cursor?.source_id !== source.sourceId || cursor?.applied_sequence !== source.head) {
    throw new Error("Derived search cursor does not match its operational source")
  }
  const indexed = database.prepare("SELECT count(*) AS n FROM search.session_messages_fts").get().n
  const missing = database
    .prepare(
      `SELECT count(*) AS n FROM (
    SELECT message_rowid AS rowid, search_text FROM main.session_messages
    EXCEPT SELECT rowid, search_text FROM search.session_messages_fts
  )`
    )
    .get().n
  const extra = database
    .prepare(
      `SELECT count(*) AS n FROM (
    SELECT rowid, search_text FROM search.session_messages_fts
    EXCEPT SELECT message_rowid AS rowid, search_text FROM main.session_messages
  )`
    )
    .get().n
  if (indexed !== source.messages || missing !== 0 || extra !== 0) {
    throw new Error("Derived search rows differ from operational transcript source")
  }
  return indexed
}

const storageFileState = (paths) =>
  [
    paths.operational,
    `${paths.operational}-wal`,
    `${paths.operational}-shm`,
    paths.search,
    `${paths.search}-wal`,
    `${paths.search}-shm`
  ].map((filename) => {
    if (!existsSync(filename)) return [filename, null]
    const file = lstatSync(filename, { bigint: true })
    return [filename, [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].map(String)]
  })

const checkStorage = (dataRoot, confirmStopped) => {
  if (!confirmStopped) throw new Error("storage check requires --confirm-stopped")
  const paths = pathsFor(dataRoot)
  assertNoWalBytes([paths.operational, paths.search])
  assertNoOpenHandles(paths)
  const before = storageFileState(paths)
  const operational = openImmutable(paths.operational)
  let result
  try {
    const source = checkOperational(operational)
    if (!existsSync(paths.search))
      throw new Error("Derived search file is absent; run explicit search rebuild")
    operational.prepare("ATTACH DATABASE ? AS search").run(immutableUri(paths.search))
    const indexed = checkDerived(operational, source)
    result = {
      status: "ok",
      operational: {
        messages: source.messages,
        schemaObjects: source.schemaObjects,
        pendingChanges: source.pendingChanges
      },
      search: { indexed, cursorAtHead: true, sourceMatches: true }
    }
  } finally {
    operational.close()
  }
  assertNoOpenHandles(paths)
  assertNoWalBytes([paths.operational, paths.search])
  if (JSON.stringify(before) !== JSON.stringify(storageFileState(paths))) {
    throw new Error("Storage files changed during read-only check")
  }
  return result
}

const assertNoOpenHandles = (paths) => {
  if (process.platform !== "darwin")
    throw new Error("Writer quiescence enforcement requires macOS lsof")
  for (const filename of [
    paths.operational,
    `${paths.operational}-wal`,
    `${paths.operational}-shm`,
    paths.search,
    `${paths.search}-wal`,
    `${paths.search}-shm`
  ]) {
    if (!existsSync(filename)) continue
    const result = spawnSync("/usr/sbin/lsof", ["-F", "p", filename], { encoding: "utf8" })
    if (
      result.error ||
      result.status === null ||
      (result.status !== 0 && result.status !== 1) ||
      result.stderr
    ) {
      throw new Error("Could not prove storage writer quiescence with lsof")
    }
    if (result.status === 0 && result.stdout.trim()) {
      throw new Error(
        "Storage file remains open; stop Arden and other SQLite clients before maintenance"
      )
    }
  }
}

const buildSearch = async (paths, filename) => {
  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const before = yield* sql.unsafe(`SELECT
        (SELECT head_sequence FROM transcript_search_clock WHERE singleton_id=1) AS head,
        (SELECT count(*) FROM transcript_search_changes) AS changes`)
        yield* initializeSearchIndex(sql, paths.operational, { searchFilename: filename })
        const after = yield* sql.unsafe(`SELECT
        (SELECT head_sequence FROM transcript_search_clock WHERE singleton_id=1) AS head,
        (SELECT count(*) FROM transcript_search_changes) AS changes`)
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          return yield* Effect.fail(
            new Error("Search rebuild changed operational source clock or log")
          )
        }
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
    )
  }).pipe(
    Effect.provide(
      SqliteClient.layer({ filename: paths.operational, disableWAL: true, busyTimeout: 0 })
    )
  )
  await Effect.runPromise(Effect.scoped(program))
}

const syncFile = (filename) => {
  const descriptor = openSync(filename, "r")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

const activateSearch = (paths, built, temporary) => {
  const old = ["", "-wal", "-shm"].filter((suffix) => existsSync(paths.search + suffix))
  const moved = []
  let published = false
  syncFile(built)
  try {
    for (const suffix of old) {
      renameSync(paths.search + suffix, join(temporary, `prior-search${suffix}`))
      moved.push(suffix)
    }
    syncFile(temporary)
    syncFile(resolve(temporary, ".."))
    renameSync(built, paths.search)
    published = true
    syncFile(resolve(temporary, ".."))
  } catch (error) {
    try {
      if (published) renameSync(paths.search, built)
      for (const suffix of moved.reverse()) {
        renameSync(join(temporary, `prior-search${suffix}`), paths.search + suffix)
      }
      syncFile(resolve(temporary, ".."))
    } catch (restoreError) {
      const failure = new AggregateError(
        [error, restoreError],
        `Search activation and restoration both failed; retained prior search files in ${temporary}`
      )
      failure.retainTemporary = true
      throw failure
    }
    throw error
  }
}

const rebuildSearch = async (dataRoot, confirmStopped) => {
  if (!confirmStopped) throw new Error("search rebuild requires --confirm-stopped")
  const paths = pathsFor(dataRoot)
  assertNoWalBytes([paths.operational])
  assertNoOpenHandles(paths)
  const operational = openImmutable(paths.operational)
  let source
  try {
    source = checkOperational(operational)
  } finally {
    operational.close()
  }
  const temporary = mkdtempSync(join(dataRoot, ".search-rebuild-"))
  const built = join(temporary, "search.sqlite")
  let retainTemporary = false
  try {
    await buildSearch(paths, built)
    requireFile(built)
    const normalized = new DatabaseSync(built)
    try {
      normalized.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      if (normalized.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") {
        throw new Error("Temporary search journal could not be checkpointed")
      }
    } finally {
      normalized.close()
    }
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(built + suffix))
        throw new Error("Temporary search has an uncheckpointed sidecar")
    }
    chmodSync(built, 0o600)
    assertNoWalBytes([paths.operational])
    const check = openImmutable(paths.operational)
    try {
      const after = checkOperational(check)
      if (JSON.stringify(after) !== JSON.stringify(source)) {
        throw new Error("Operational source changed during search rebuild")
      }
      check.prepare("ATTACH DATABASE ? AS search").run(immutableUri(built))
      checkDerived(check, source)
    } finally {
      check.close()
    }
    assertNoOpenHandles(paths)
    activateSearch(paths, built, temporary)
    return checkStorage(dataRoot, true)
  } catch (error) {
    retainTemporary = error?.retainTemporary === true
    throw error
  } finally {
    if (!retainTemporary) rmSync(temporary, { recursive: true, force: true })
  }
}

const parse = (args) => {
  const command = args.slice(0, 2).join(" ")
  if (command !== "storage check" && command !== "search rebuild") throw new Error(usage)
  let dataRoot
  let confirmStopped = false
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === "--data-root" && args[index + 1]) {
      dataRoot = args[++index]
    } else if (args[index] === "--confirm-stopped") {
      confirmStopped = true
    } else {
      throw new Error(usage)
    }
  }
  if (!dataRoot || !confirmStopped) throw new Error(usage)
  return { command, dataRoot, confirmStopped }
}

try {
  const args = parse(process.argv.slice(2))
  const result =
    args.command === "storage check"
      ? checkStorage(args.dataRoot, args.confirmStopped)
      : await rebuildSearch(args.dataRoot, args.confirmStopped)
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`storage maintenance: ${errorMessage(error)}\n`)
  process.exitCode = 1
}
