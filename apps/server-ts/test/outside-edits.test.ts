import { readdirSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryShape
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { commitWiki, createPage } from "../src/wiki/commit.js"
import { makeOutsideEdits, type OutsideEditCheck } from "../src/wiki/outside-edits.js"
import { formatRedirectPage, formatWikiPage } from "../src/wiki/page.js"
import { loadSnapshot } from "../src/wiki/snapshot.js"
import { partialService } from "./kit.js"

// Made-up pages on a temporary Memory folder; nothing here comes from anyone's Memory.

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const page = (pageId: string, body = `About ${pageId}.\n`) =>
  formatWikiPage({
    pageId,
    title: `Page ${pageId}`,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body
  })

const PAGES: ReadonlyArray<readonly [pageId: string, path: string, content: string]> = [
  ["edited", "notes/edited.md", page("edited")],
  ["deleted", "notes/deleted.md", page("deleted")],
  ["target", "notes/target.md", page("target")],
  [
    "old-name",
    "notes/old-name.md",
    formatRedirectPage({ pageId: "old-name", title: "Old", redirectTo: "target" })
  ],
  ["unreadable", "notes/unreadable.md", page("unreadable")],
  ["broken", "notes/broken.md", page("broken")],
  ["renamed-id", "notes/renamed-id.md", page("renamed-id")],
  ["kept", "notes/kept.md", page("kept")],
  ["folder-readme", "old/README.md", page("folder-readme")],
  ["folder-page", "old/inner.md", page("folder-page")]
]

const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {
  hasPageBinding: () => Effect.succeed(false)
})

const withMemory = async <A>(
  use: (memory: {
    readonly root: string
    readonly repository: ManagedFileRepositoryShape
    readonly check: () => Effect.Effect<OutsideEditCheck, unknown>
    readonly commits: () => Effect.Effect<number, unknown>
  }) => Effect.Effect<A, unknown>
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "arden-outside-edits-"))
  roots.push(root)
  return Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      yield* commitWiki(
        repository,
        {
          actor: "test",
          origin: { kind: "system", name: "test" },
          reason: "seed",
          expectedRevision: null
        },
        PAGES.map(([pageId, path, content]) => createPage(pageId, path, content))
      )
      const outside = makeOutsideEdits({
        repository,
        spaces,
        snapshot: () => loadSnapshot(repository, "list")
      })
      const commits = () => repository.history().pipe(Effect.map((history) => history.length))
      return yield* use({ root, repository, check: outside.check, commits })
    }).pipe(Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })))
  )
}

/** The check's result with each refusal's wording left out. */
const shape = (result: OutsideEditCheck) => ({
  takenIn: result.takenIn.map((item) => [item.path, item.action]),
  setAside: result.setAside.map((item) => [item.path, item.reason]),
  notInMemory: result.notInMemory,
  changedDuringCheck: result.changedDuringCheck,
  otherFiles: result.otherFiles
})

describe("changes made outside Arden", () => {
  it("adds no commit and lists nothing when every file matches history", async () => {
    const result = await withMemory(({ check, commits }) =>
      Effect.gen(function* () {
        const before = yield* commits()
        const checked = yield* check()
        return { checked: shape(checked), added: (yield* commits()) - before }
      })
    )
    expect(result).toEqual({
      checked: {
        takenIn: [],
        setAside: [],
        notInMemory: [],
        changedDuringCheck: [],
        otherFiles: []
      },
      added: 0
    })
  })

  it("takes in what the rules allow, sets the rest aside, and leaves recall on the last good version", async () => {
    const result = await withMemory(({ root, repository, check, commits }) =>
      Effect.gen(function* () {
        const before = yield* commits()
        yield* Effect.promise(async () => {
          await writeFile(join(root, "notes/edited.md"), page("edited", "Changed outside.\n"))
          await unlink(join(root, "notes/deleted.md"))
          await unlink(join(root, "notes/target.md"))
          await unlink(join(root, "notes/unreadable.md"))
          await mkdir(join(root, "notes/unreadable.md"))
          await writeFile(join(root, "notes/broken.md"), "---\npage_id: [\n---\nbody\n")
          await writeFile(join(root, "notes/renamed-id.md"), page("someone-else"))
          await writeFile(join(root, "notes/new.md"), page("new"))
          await writeFile(join(root, "notes/scratch.txt"), "not a page")
        })
        const checked = yield* check()
        const added = (yield* commits()) - before
        const history = yield* repository.history({ limit: added })
        const snapshot = yield* loadSnapshot(repository, "list")
        const again = yield* check()
        const status = yield* repository.workingTreeStatus
        return {
          checked: shape(checked),
          added,
          actors: history.map((commit) => commit.actor),
          kept: snapshot.pages
            .filter((record) =>
              ["target", "unreadable", "broken", "renamed-id"].includes(record.page.pageId)
            )
            .map((record) => record.page.body),
          edited: snapshot.pages.find((record) => record.page.pageId === "edited")?.page.body,
          deleted: snapshot.pages.some((record) => record.page.pageId === "deleted"),
          againAdded: (yield* commits()) - before - added,
          again: shape(again),
          leftOver: status.changes.map((change) => change.resource.path).sort()
        }
      })
    )
    const setAside = [
      ["notes/broken.md", "refused"],
      ["notes/renamed-id.md", "refused"],
      ["notes/unreadable.md", "unreadable"],
      ["notes/target.md", "refused"]
    ]
    expect(result).toEqual({
      checked: {
        takenIn: [
          ["notes/edited.md", "update"],
          ["notes/deleted.md", "archive"]
        ],
        setAside,
        notInMemory: ["notes/new.md"],
        changedDuringCheck: [],
        otherFiles: ["notes/scratch.txt"]
      },
      added: 2,
      actors: ["user:external", "user:external"],
      kept: [
        "About target.\n",
        "About unreadable.\n",
        "About broken.\n",
        "About renamed-id.\n"
      ].sort(),
      edited: "Changed outside.\n",
      deleted: false,
      againAdded: 0,
      again: {
        takenIn: [],
        setAside,
        notInMemory: ["notes/new.md"],
        changedDuringCheck: [],
        otherFiles: ["notes/scratch.txt"]
      },
      leftOver: setAside.map(([path]) => path).sort()
    })
  })

  it("records two edits to one page made between checks as one change", async () => {
    const result = await withMemory(({ root, check, commits }) =>
      Effect.gen(function* () {
        const before = yield* commits()
        yield* Effect.promise(async () => {
          await writeFile(join(root, "notes/kept.md"), page("kept", "First.\n"))
          await writeFile(join(root, "notes/kept.md"), page("kept", "Second.\n"))
        })
        const checked = yield* check()
        return { takenIn: checked.takenIn.length, added: (yield* commits()) - before }
      })
    )
    expect(result).toEqual({ takenIn: 1, added: 1 })
  })

  it("archives a folder deleted outside, its README last, in one check", async () => {
    const result = await withMemory(({ root, check }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => rm(join(root, "old"), { recursive: true }))
        return shape(yield* check())
      })
    )
    expect(result.takenIn).toEqual([
      ["old/inner.md", "archive"],
      ["old/README.md", "archive"]
    ])
    expect(result.setAside).toEqual([])
  })

  it("never rewrites a file it set aside", async () => {
    const written = await withMemory(({ root, check }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(root, "notes/broken.md"), "not a page"))
        yield* check()
        return yield* Effect.promise(() => readFile(join(root, "notes/broken.md"), "utf8"))
      })
    )
    expect(written).toBe("not a page")
  })
})

const SOURCE = join(import.meta.dirname, "../src")

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

const naming = (pattern: RegExp): ReadonlyArray<string> =>
  sources(SOURCE)
    .map((path) => relative(SOURCE, path))
    .filter((path) => pattern.test(readFileSync(join(SOURCE, path), "utf8")))

describe("one owner for reading files against Memory history", () => {
  it("scans and takes in only in wiki/outside-edits.ts", () => {
    expect(naming(/\b(?:workingTreeStatus|adoptWorkingChange)\b/u)).toEqual([
      "wiki/outside-edits.ts"
    ])
  })

  it("runs the check only from the Memory poll, never on a chat turn", () => {
    expect(naming(/\bcheckOutsideEdits\(/u)).toEqual(["automations/producers/wiki.ts"])
    expect(
      naming(/outside-edits\.js|checkOutsideEdits/u).filter(
        (path) => path.startsWith("memory/") || path.startsWith("context/")
      )
    ).toEqual([])
  })
})
