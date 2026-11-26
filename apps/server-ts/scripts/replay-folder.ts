import { lstatSync, readdirSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { ERRNO, isErrnoCode } from "@arden-hq/std/errors"
import { ARDEN_DIR_VARIABLE, isWithin, resolveArdenDir } from "@arden-hq/std/paths"

const MEMORY_FOLDER = "memory"
const WIKI_FOLDER = "wiki"

export const REPLAY_COPY_VARIABLE = "ARDEN_REPLAY_COPY"

export interface ReplayFolder {
  readonly folder: string
  readonly database: string
  readonly wiki: string
}

export const replayFolder = (folder: string): ReplayFolder => ({
  folder,
  database: join(folder, "arden.db"),
  wiki: join(folder, MEMORY_FOLDER, WIKI_FOLDER)
})

const DATABASE_NAMES = ["arden.db", "search.sqlite"]
const SIDECARS = ["", "-journal", "-wal", "-shm"]
const TOP_LEVEL = new Set(DATABASE_NAMES.flatMap((name) => SIDECARS.map((suffix) => name + suffix)))
const PARTIAL_COPY = "arden.db.partial"

const SECRET_EXTENSION = /\.(pem|key|p8|p12|pfx|crt|cer)$/i
const SECRET_NAME = /oauth|token|credential|secret|private[-_]?key|id_rsa|id_ed25519|apns/i

const realDataFolders = (): ReadonlyArray<string> => [
  ...new Set([
    resolveArdenDir({}),
    resolveArdenDir({ [ARDEN_DIR_VARIABLE]: process.env[ARDEN_DIR_VARIABLE] })
  ])
]

const canonical = (path: string): string => {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute))
  }
}

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
    if (isErrnoCode(cause, ERRNO.ENOENT)) return []
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

export const assertReplayFolder = (folder: string): ReplayFolder => {
  assertOutsideRealData(folder)
  const layout = replayFolder(canonical(folder))
  let names: ReadonlyArray<string>
  try {
    names = readdirSync(layout.folder)
  } catch (cause) {
    if (isErrnoCode(cause, ERRNO.ENOENT)) return layout
    throw cause
  }
  for (const name of names) {
    const path = join(layout.folder, name)
    if (lstatSync(path).isSymbolicLink())
      throw new Error(`Refusing replay folder: ${path} is a symlink`)
    if (TOP_LEVEL.has(name) || name === PARTIAL_COPY) continue
    if (name === MEMORY_FOLDER) {
      const inner = readdirSync(path)
      if (inner.some((child) => child !== WIKI_FOLDER))
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

export const partialDatabase = (layout: ReplayFolder): string => join(layout.folder, PARTIAL_COPY)
