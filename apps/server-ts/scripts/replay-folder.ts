// The one guard for replay folders: a copy of the owner's database and Memory
// folder that replays read and write. Both the copy script (scripts/replay-copy.ts)
// and the test helper (test/fixtures/replay-copy.ts) call it, so neither can
// point a replay at the owner's real data or at a folder that holds sign-ins.
//
// This file runs under Node's type stripping as well as under vitest: it may
// import only Node built-ins and `@arden-hq/std/paths`, which has no relative
// imports of its own.

import { lstatSync, readdirSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { ARDEN_DIR_VARIABLE, isWithin, resolveArdenDir } from "@arden-hq/std/paths"

/** The environment variable that names the replay folder for tests that need the copy. */
export const REPLAY_COPY_VARIABLE = "ARDEN_REPLAY_COPY"

export interface ReplayFolder {
  readonly folder: string
  readonly database: string
  readonly wiki: string
}

/** The layout matches the engine's data root, so `dataRootLayer` can open it as one. */
export const replayFolder = (folder: string): ReplayFolder => ({
  folder,
  database: join(folder, "arden.db"),
  wiki: join(folder, "memory", "wiki")
})

const DATABASE_NAMES = ["arden.db", "search.sqlite"]
const SIDECARS = ["", "-journal", "-wal", "-shm"]
const TOP_LEVEL = new Set(DATABASE_NAMES.flatMap((name) => SIDECARS.map((suffix) => name + suffix)))
const PARTIAL_COPY = "arden.db.partial"

// Names that mark a sign-in, a key or a token. Memory pages are Markdown and
// may name these words, so the name check skips `.md` files; the extension
// check does not.
const SECRET_EXTENSION = /\.(pem|key|p8|p12|pfx|crt|cer)$/i
const SECRET_NAME = /oauth|token|credential|secret|private[-_]?key|id_rsa|id_ed25519|apns/i

/** The real data folders: the owner's `~/.arden`, and `ARDEN_DIR` when it names another. */
const realDataFolders = (): ReadonlyArray<string> => [
  ...new Set([
    resolveArdenDir({}),
    resolveArdenDir({ [ARDEN_DIR_VARIABLE]: process.env[ARDEN_DIR_VARIABLE] })
  ])
]

/** The path with every existing ancestor resolved through symlinks. */
const canonical = (path: string): string => {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute))
  }
}

/** Refuses a folder that is, or is inside, a real data folder. The folder need not exist. */
export const assertOutsideRealData = (folder: string): void => {
  const target = canonical(folder)
  for (const real of realDataFolders()) {
    const root = canonical(real)
    if (isWithin(root, target) || isWithin(target, root))
      throw new Error(`Refusing replay folder ${target}: it overlaps the real data folder ${root}`)
  }
}

const entriesOf = (folder: string) => {
  try {
    return readdirSync(folder, { withFileTypes: true })
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return []
    throw cause
  }
}

const secretIn = (folder: string): string | undefined => {
  for (const entry of entriesOf(folder)) {
    const path = join(folder, entry.name)
    if (entry.isSymbolicLink()) return path
    if (SECRET_EXTENSION.test(entry.name)) return path
    if (!entry.name.endsWith(".md") && SECRET_NAME.test(entry.name)) return path
    if (entry.isDirectory()) {
      const found = secretIn(path)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * Refuses a replay folder that overlaps the real data, holds anything at its top
 * level beyond the database files and `memory/wiki`, or holds a file whose name
 * marks a token or a key (or any symlink) anywhere below it. An absent or empty
 * folder passes.
 */
export const assertReplayFolder = (folder: string): ReplayFolder => {
  assertOutsideRealData(folder)
  const layout = replayFolder(canonical(folder))
  let names: ReadonlyArray<string>
  try {
    names = readdirSync(layout.folder)
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return layout
    throw cause
  }
  for (const name of names) {
    const path = join(layout.folder, name)
    if (lstatSync(path).isSymbolicLink())
      throw new Error(`Refusing replay folder: ${path} is a symlink`)
    if (TOP_LEVEL.has(name) || name === PARTIAL_COPY) continue
    if (name === "memory") {
      const inner = readdirSync(path)
      if (inner.some((child) => child !== "wiki"))
        throw new Error(`Refusing replay folder: ${path} holds more than wiki`)
      continue
    }
    throw new Error(`Refusing replay folder: ${path} is not a database file or the Memory folder`)
  }
  const secret = secretIn(layout.folder)
  if (secret !== undefined)
    throw new Error(`Refusing replay folder: ${secret} looks like a token, a key or a link`)
  return layout
}

/** The partial file the copy script writes before it renames it to `arden.db`. */
export const partialDatabase = (layout: ReplayFolder): string => join(layout.folder, PARTIAL_COPY)
