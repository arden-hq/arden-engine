import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { assertReplayFolder } from "../scripts/replay-folder.js"

let root = ""

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "arden-replay-folder-")))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const copyAt = (folder: string) => {
  mkdirSync(join(folder, "memory", "wiki", "pages"), { recursive: true })
  writeFileSync(join(folder, "arden.db"), "")
  writeFileSync(join(folder, "memory", "wiki", "pages", "api-tokens.md"), "")
  return folder
}

it("accepts a copy that holds only the database and the Memory folder", () => {
  const folder = copyAt(join(root, "copy"))
  writeFileSync(join(folder, "search.sqlite"), "")
  expect(assertReplayFolder(folder).database).toBe(join(folder, "arden.db"))
})

it("accepts a folder that does not exist yet", () => {
  expect(() => assertReplayFolder(join(root, "later"))).not.toThrow()
})

it("refuses the owner's data folder and anything inside it", () => {
  const owner = join(homedir(), ".arden")
  expect(() => assertReplayFolder(owner)).toThrow(/real data folder/)
  expect(() => assertReplayFolder(join(owner, "replay"))).toThrow(/real data folder/)
})

it("refuses the folder ARDEN_DIR names, and a folder that contains it", () => {
  const data = join(root, "data")
  mkdirSync(data)
  vi.stubEnv("ARDEN_DIR", data)
  expect(() => assertReplayFolder(join(data, "copy"))).toThrow(/real data folder/)
  expect(() => assertReplayFolder(root)).toThrow(/real data folder/)
})

it("refuses a link into the real data folder", () => {
  const data = join(root, "data")
  mkdirSync(data)
  vi.stubEnv("ARDEN_DIR", data)
  const link = join(root, "link")
  symlinkSync(data, link)
  expect(() => assertReplayFolder(link)).toThrow(/real data folder/)
})

it.each([
  ["a sign-in file at the top", ["google-oauth-client.json"]],
  ["a private key at the top", ["github-app-private-key.pem"]],
  ["another database", ["memory.db"]],
  ["a key inside the Memory folder", ["memory", "wiki", "signing.key"]],
  ["a token inside the Memory folder", ["memory", "wiki", ".wiki-history", "token.json"]],
  ["another folder beside the wiki", ["memory", "mcp_oauth"]]
])("refuses %s", (_case, path) => {
  const folder = copyAt(join(root, "copy"))
  mkdirSync(join(folder, ...path.slice(0, -1)), { recursive: true })
  writeFileSync(join(folder, ...path), "")
  expect(() => assertReplayFolder(folder)).toThrow(/Refusing replay folder/)
})

it("refuses a link anywhere in the copy", () => {
  const folder = copyAt(join(root, "copy"))
  symlinkSync(root, join(folder, "memory", "wiki", "pages", "elsewhere"))
  expect(() => assertReplayFolder(folder)).toThrow(/link/)
})

// Real data reaches a test only through the replay copy: a fixed, migrated snapshot the guard
// above checks. A test that opened the owner's live data directory would assert on data that
// changes under it, and its result would depend on when it ran.
it("leaves no test reading the owner's live data directory", () => {
  const TEST = import.meta.dirname
  const offenders = readdirSync(TEST, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => readFileSync(join(TEST, name), "utf8").includes("ownerDataDirectory("))
    .filter((name) => name !== "replay-folder.test.ts")
  expect(offenders).toEqual([])
})
