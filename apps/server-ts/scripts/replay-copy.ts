import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync
} from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { backup, DatabaseSync } from "node:sqlite"
import { resolveArdenDir } from "@arden-hq/std/paths"
import { assertOutsideRealData, assertReplayFolder, partialDatabase } from "./replay-folder.ts"

const usage = `Usage:
  node --conditions=arden-source scripts/replay-copy.ts --into <absolute folder> [--from <data folder>] [--replace]

Copies <data folder>/arden.db and <data folder>/memory/wiki (default ~/.arden) into
<absolute folder>, reading the source only. Copies nothing else. --replace deletes an
earlier copy in <absolute folder> first; without it an earlier copy is refused.`

const QUICK_CHECK_OK = "ok"
const MIN_FREE_BYTES = 10 * 1024 ** 3
const REPORTED_TABLES = [
  "automation_runs",
  "automation_event_queue",
  "run_sidecars",
  "session_turns"
]
const SOURCE_DATABASE_FILES = ["arden.db", "arden.db-journal", "arden.db-wal", "arden.db-shm"]

const { values } = parseArgs({
  options: {
    into: { type: "string" },
    from: { type: "string" },
    replace: { type: "boolean", default: false },
    help: { type: "boolean", default: false }
  }
})
if (values.help || values.into === undefined || !isAbsolute(values.into)) {
  console.error(usage)
  process.exit(values.help ? 0 : 2)
}

const source = resolve(values.from ?? resolveArdenDir({}))
const sourceDatabase = join(source, "arden.db")
const sourceWiki = join(source, "memory", "wiki")
assertOutsideRealData(values.into)
const into = assertReplayFolder(values.into)

type Stamp = { readonly size: number; readonly mtimeMs: number }
type Snapshot = ReadonlyMap<string, Stamp>

const snapshot = (): Snapshot => {
  const stamps = new Map<string, Stamp>()
  const add = (path: string, relative: string) => {
    const stat = lstatSync(path)
    stamps.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs })
  }
  for (const name of readdirSync(source)) add(join(source, name), name)
  const walk = (folder: string, relative: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      const name = `${relative}/${entry.name}`
      add(path, name)
      if (entry.isDirectory()) walk(path, name)
    }
  }
  walk(sourceWiki, "memory/wiki")
  return stamps
}

const changed = (before: Snapshot, after: Snapshot): ReadonlyArray<string> => {
  const names = new Set([...before.keys(), ...after.keys()])
  return [...names].filter((name) => {
    const a = before.get(name)
    const b = after.get(name)
    return a === undefined || b === undefined || a.size !== b.size || a.mtimeMs !== b.mtimeMs
  })
}

const isDatabaseFile = (name: string) => SOURCE_DATABASE_FILES.includes(name)
const isWikiFile = (name: string) => name.startsWith("memory/wiki/")

const sizeOf = (path: string): number => {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return stat.size
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0)
}

const freeBytes = (path: string): number => {
  let folder = path
  while (!existsSync(folder)) folder = dirname(folder)
  const stats = statfsSync(folder)
  return stats.bavail * stats.bsize
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`

const fail = (message: string): never => {
  rmSync(partialDatabase(into), { force: true })
  console.error(message)
  process.exit(1)
}

if (!existsSync(sourceDatabase) || !lstatSync(sourceDatabase).isFile())
  fail(`No database at ${sourceDatabase}`)
if (!existsSync(sourceWiki) || !lstatSync(sourceWiki).isDirectory())
  fail(`No Memory folder at ${sourceWiki}`)

const UNFINISHED_WRITE_FILES = ["arden.db-journal", "arden.db-wal"]
for (const name of UNFINISHED_WRITE_FILES) {
  const path = join(source, name)
  if (existsSync(path) && lstatSync(path).size > 0)
    fail(`${path} is not empty: Arden is writing. Quit it or try again later.`)
}

if (existsSync(into.database) || existsSync(into.wiki)) {
  if (!values.replace)
    fail(`${into.folder} already holds a copy. Pass --replace to delete it first.`)
  rmSync(into.folder, { recursive: true, force: true })
}
rmSync(partialDatabase(into), { force: true })

const needed = sizeOf(sourceDatabase) + sizeOf(sourceWiki)
const free = freeBytes(into.folder)
if (free < MIN_FREE_BYTES)
  fail(`Only ${gb(free)} free; the copy needs at least ${gb(MIN_FREE_BYTES)} free.`)
if (free - needed < MIN_FREE_BYTES / 2)
  fail(
    `Only ${gb(free)} free for a ${gb(needed)} copy; that would leave under ${gb(MIN_FREE_BYTES / 2)}.`
  )

mkdirSync(into.folder, { recursive: true, mode: 0o700 })
const started = performance.now()
const before = snapshot()

// immutable=1 takes no lock and skips change detection: https://www.sqlite.org/uri.html#uriimmutable
const sourceUri = pathToFileURL(sourceDatabase)
sourceUri.searchParams.set("mode", "ro")
sourceUri.searchParams.set("immutable", "1")
const reader = new DatabaseSync(sourceUri.href, { readOnly: true })
const sourceVersion = reader.prepare("PRAGMA user_version").get()?.user_version
const partial = partialDatabase(into)
try {
  await backup(reader, partial, { rate: 16_384 })
} finally {
  reader.close()
}

const check = new DatabaseSync(partial)
try {
  const result = check.prepare("PRAGMA quick_check").all()
  if (result.length !== 1 || result[0]?.quick_check !== QUICK_CHECK_OK)
    fail(`The copy failed its integrity check: ${JSON.stringify(result.slice(0, 5))}`)
  const version = check.prepare("PRAGMA user_version").get()?.user_version
  if (version !== sourceVersion)
    fail(`The copy is at schema ${String(version)}, the source at ${String(sourceVersion)}`)
} finally {
  check.close()
}

cpSync(sourceWiki, into.wiki, {
  recursive: true,
  preserveTimestamps: true,
  errorOnExist: true,
  force: false,
  filter: (path) => {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to copy the link ${path}`)
    return true
  }
})

const after = snapshot()
const moved = changed(before, after)
const torn = moved.filter((name) => isDatabaseFile(name) || isWikiFile(name))
if (torn.length > 0) {
  rmSync(into.wiki, { recursive: true, force: true })
  fail(`The source changed while it was copied, so the copy may be torn: ${torn.join(", ")}`)
}
renameSync(partial, into.database)
chmodSync(into.database, 0o600)
assertReplayFolder(into.folder)
const seconds = (performance.now() - started) / 1000

const copy = new DatabaseSync(into.database, { readOnly: true })
const counts = Object.fromEntries(
  REPORTED_TABLES.map((table) => [
    table,
    copy.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n
  ])
)
copy.close()

console.log(
  JSON.stringify(
    {
      folder: into.folder,
      database_bytes: sizeOf(into.database),
      wiki_bytes: sizeOf(into.wiki),
      seconds: Number(seconds.toFixed(1)),
      schema_version: sourceVersion,
      rows: counts,
      source_changed_elsewhere: moved
    },
    null,
    2
  )
)
