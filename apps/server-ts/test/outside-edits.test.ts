import { readdirSync, readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises"
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
import { commitWiki, createPage, updatePage } from "../src/wiki/commit.js"
import {
  makeOutsideEdits,
  MAX_MISSING_ARCHIVED,
  type OutsideEditCheck
} from "../src/wiki/outside-edits.js"
import { formatRedirectPage, formatWikiPage } from "../src/wiki/page.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { makeWikiMutationMethods } from "../src/wiki/mutations.js"
import { wikiFailure } from "../src/tools/wiki.js"
import { wikiError, type WikiError } from "../src/wiki/errors.js"
import { loadSnapshot, type Snapshot } from "../src/wiki/snapshot.js"
import { partialService } from "./kit.js"

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
  activeBindings: () => Effect.succeed([])
})

interface Memory {
  readonly root: string
  readonly repository: ManagedFileRepositoryShape
  readonly check: () => Effect.Effect<OutsideEditCheck, unknown>
  readonly settle: () => Effect.Effect<OutsideEditCheck, unknown>
  readonly commits: () => Effect.Effect<number, unknown>
  readonly snapshot: () => Effect.Effect<Snapshot, unknown>
  readonly outside: ReturnType<typeof makeOutsideEdits>
}

const withMemory = async <A>(
  use: (memory: Memory) => Effect.Effect<A, unknown>,
  options: {
    readonly extra?: ReadonlyArray<readonly [pageId: string, path: string, content: string]>
    readonly snapshot?: (
      repository: ManagedFileRepositoryShape
    ) => () => Effect.Effect<Snapshot, WikiError>
  } = {}
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
        [...PAGES, ...(options.extra ?? [])].map(([pageId, path, content]) =>
          createPage(pageId, path, content)
        )
      )
      const outside = makeOutsideEdits({
        repository,
        spaces,
        snapshot: options.snapshot?.(repository) ?? (() => loadSnapshot(repository, "list"))
      })
      const commits = () => repository.history().pipe(Effect.map((history) => history.length))
      return yield* use({
        root,
        repository,
        check: outside.check,
        settle: () => outside.check().pipe(Effect.andThen(outside.check())),
        commits,
        snapshot: () => loadSnapshot(repository, "list"),
        outside
      })
    }).pipe(Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })))
  )
}

const shape = (result: OutsideEditCheck) => ({
  takenIn: result.takenIn.map((item) => [item.path, item.action]),
  setAside: result.setAside.map((item) => [item.path, item.reason]),
  settling: result.settling,
  notInMemory: result.notInMemory,
  changedDuringCheck: result.changedDuringCheck,
  otherFiles: result.otherFiles,
  unreadableFiles: result.unreadableFiles.map((item) => item.path)
})

const NOTHING = {
  takenIn: [],
  setAside: [],
  settling: [],
  notInMemory: [],
  changedDuringCheck: [],
  otherFiles: [],
  unreadableFiles: []
}

describe("changes made outside Arden", () => {
  it("adds no commit and lists nothing when every file matches history", async () => {
    const result = await withMemory(({ check, commits }) =>
      Effect.gen(function* () {
        const before = yield* commits()
        const checked = yield* check()
        return { checked: shape(checked), added: (yield* commits()) - before }
      })
    )
    expect(result).toEqual({ checked: NOTHING, added: 0 })
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
        const first = yield* check()
        const firstAdded = (yield* commits()) - before
        const checked = yield* check()
        const added = (yield* commits()) - before
        const history = yield* repository.history({ limit: added })
        const snapshot = yield* loadSnapshot(repository, "list")
        const again = yield* check()
        const status = yield* repository.workingTreeStatus()
        return {
          first: shape(first),
          firstAdded,
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
    const listed = { notInMemory: ["notes/new.md"], otherFiles: ["notes/scratch.txt"] }
    expect(result).toEqual({
      first: {
        ...NOTHING,
        ...listed,
        settling: [
          "notes/broken.md",
          "notes/edited.md",
          "notes/renamed-id.md",
          "notes/unreadable.md",
          "notes/deleted.md",
          "notes/target.md"
        ]
      },
      firstAdded: 0,
      checked: {
        ...NOTHING,
        ...listed,
        takenIn: [
          ["notes/edited.md", "update"],
          ["notes/deleted.md", "archive"]
        ],
        setAside
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
      again: { ...NOTHING, ...listed, setAside },
      leftOver: setAside.map(([path]) => path).sort()
    })
  })

  it("records two edits to one page made between checks as one change", async () => {
    const result = await withMemory(({ root, settle, commits }) =>
      Effect.gen(function* () {
        const before = yield* commits()
        yield* Effect.promise(async () => {
          await writeFile(join(root, "notes/kept.md"), page("kept", "First.\n"))
          await writeFile(join(root, "notes/kept.md"), page("kept", "Second.\n"))
        })
        const checked = yield* settle()
        return { takenIn: checked.takenIn.length, added: (yield* commits()) - before }
      })
    )
    expect(result).toEqual({ takenIn: 1, added: 1 })
  })

  it("archives a folder deleted outside, its README last, in one check", async () => {
    const result = await withMemory(({ root, settle }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => rm(join(root, "old"), { recursive: true }))
        return shape(yield* settle())
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
        yield* check()
        return yield* Effect.promise(() => readFile(join(root, "notes/broken.md"), "utf8"))
      })
    )
    expect(written).toBe("not a page")
  })
})

describe("a file is decided only once it has stayed the same for one poll", () => {
  it("keeps a page deleted and put back before the next check", async () => {
    const result = await withMemory(({ root, check, commits, snapshot }) =>
      Effect.gen(function* () {
        const before = yield* commits()
        yield* Effect.promise(() => unlink(join(root, "notes/kept.md")))
        const first = yield* check()
        yield* Effect.promise(() => writeFile(join(root, "notes/kept.md"), page("kept")))
        const second = yield* check()
        return {
          first: shape(first),
          second: shape(second),
          added: (yield* commits()) - before,
          kept: (yield* snapshot()).pages.some((record) => record.page.pageId === "kept")
        }
      })
    )
    expect(result).toEqual({
      first: { ...NOTHING, settling: ["notes/kept.md"] },
      second: NOTHING,
      added: 0,
      kept: true
    })
  })

  it("takes in a file caught halfway through a save only once the save is whole", async () => {
    const result = await withMemory(({ root, check, commits, snapshot }) =>
      Effect.gen(function* () {
        const before = yield* commits()
        const whole = page("kept", "The whole saved body.\n")
        yield* Effect.promise(() => writeFile(join(root, "notes/kept.md"), whole.slice(0, -8)))
        const halfway = yield* check()
        yield* Effect.promise(() => writeFile(join(root, "notes/kept.md"), whole))
        const saved = yield* check()
        const settled = yield* check()
        return {
          settling: [halfway.settling, saved.settling, settled.settling],
          takenIn: settled.takenIn.map((item) => item.action),
          added: (yield* commits()) - before,
          body: (yield* snapshot()).pages.find((record) => record.page.pageId === "kept")?.page.body
        }
      })
    )
    expect(result).toEqual({
      settling: [["notes/kept.md"], ["notes/kept.md"], []],
      takenIn: ["update"],
      added: 1,
      body: "The whole saved body.\n"
    })
  })
})

describe("a page missing from its place", () => {
  it("is set aside, not archived, when its file moved to a new path", async () => {
    const result = await withMemory(({ root, settle, snapshot }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await rename(join(root, "notes/kept.md"), join(root, "kept-moved.md"))
          await writeFile(join(root, "notes/edited.md"), page("edited", "Moved and edited.\n"))
          await rename(join(root, "notes/edited.md"), join(root, "elsewhere.md"))
        })
        const checked = shape(yield* settle())
        const pages = (yield* snapshot()).pages.map((record) => record.page.pageId)
        return { checked, inMemory: ["kept", "edited"].filter((id) => pages.includes(id)) }
      })
    )
    expect(result).toEqual({
      checked: {
        ...NOTHING,
        setAside: [
          ["notes/edited.md", "moved"],
          ["notes/kept.md", "moved"]
        ],
        notInMemory: ["elsewhere.md", "kept-moved.md"]
      },
      inMemory: ["kept", "edited"]
    })
  })

  it("archives none when more pages are missing at once than one check archives", async () => {
    const many = Array.from({ length: MAX_MISSING_ARCHIVED + 1 }, (_, index) => {
      const pageId = `many-${index}`
      return [pageId, `many/${pageId}.md`, page(pageId)] as const
    })
    const result = await withMemory(
      ({ root, settle, commits }) =>
        Effect.gen(function* () {
          const before = yield* commits()
          yield* Effect.promise(() => rm(join(root, "many"), { recursive: true }))
          const checked = yield* settle()
          return {
            takenIn: checked.takenIn.length,
            setAside: new Set(checked.setAside.map((item) => item.reason)),
            count: checked.setAside.length,
            added: (yield* commits()) - before
          }
        }),
      { extra: many }
    )
    expect(result).toEqual({
      takenIn: 0,
      setAside: new Set(["many_missing"]),
      count: MAX_MISSING_ARCHIVED + 1,
      added: 0
    })
  })
})

describe("an outside change meets the rules an app edit meets", () => {
  it("sets aside an edit the commit point refuses", async () => {
    const result = await withMemory(({ root, settle, commits }) =>
      Effect.gen(function* () {
        const before = yield* commits()
        yield* Effect.promise(() =>
          writeFile(
            join(root, "notes/kept.md"),
            "---\npage_id: kept\ntitle: Page kept\naliases:\n  - notes/kept.md\nlifecycle: active\n---\nBody.\n"
          )
        )
        const checked = yield* settle()
        return {
          setAside: checked.setAside.map((item) => [item.path, item.reason]),
          added: (yield* commits()) - before
        }
      })
    )
    expect(result).toEqual({ setAside: [["notes/kept.md", "refused"]], added: 0 })
  })

  it("decides again when Memory changes while the check runs", async () => {
    let loads = 0
    const result = await withMemory(
      ({ root, settle, check, snapshot }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => unlink(join(root, "notes/kept.md")))
          const raced = shape(yield* settle())
          const after = shape(yield* check())
          const pages = yield* snapshot()
          return {
            raced,
            after,
            kept: pages.pages.find((record) => record.page.pageId === "kept")?.page.lifecycle
          }
        }),
      {
        snapshot: (repository) => () =>
          loadSnapshot(repository, "list").pipe(
            Effect.tap((current) => {
              loads += 1
              const source = current.pages.find((record) => record.page.pageId === "folder-page")
              if (loads !== 2 || source === undefined) return Effect.void
              return commitWiki(
                repository,
                {
                  actor: "test",
                  origin: { kind: "system", name: "test" },
                  reason: "merge",
                  expectedRevision: current.head
                },
                [
                  updatePage(
                    source.resource,
                    formatRedirectPage({
                      pageId: "folder-page",
                      title: "Inner",
                      redirectTo: "kept"
                    })
                  )
                ]
              ).pipe(Effect.mapError((cause) => wikiError("observe", "storage", cause.message)))
            })
          )
      }
    )
    expect(result).toEqual({
      raced: { ...NOTHING, changedDuringCheck: ["notes/kept.md"] },
      after: { ...NOTHING, setAside: [["notes/kept.md", "refused"]] },
      kept: "active"
    })
  })

  it("lists a folder it cannot read and still takes in the rest", async () => {
    const result = await withMemory(({ root, settle }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await writeFile(join(root, "notes/edited.md"), page("edited", "Changed outside.\n"))
          await mkdir(join(root, "locked"))
          await chmod(join(root, "locked"), 0o000)
        })
        return yield* settle().pipe(
          Effect.ensuring(Effect.promise(() => chmod(join(root, "locked"), 0o700)))
        )
      })
    )
    expect(shape(result)).toEqual({
      ...NOTHING,
      takenIn: [["notes/edited.md", "update"]],
      unreadableFiles: ["locked"]
    })
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

describe("a write to a page whose file changed outside", () => {
  it("is refused once, not as a conflict to retry, with where the page stands", async () => {
    const outcome = await withMemory(({ root, repository, settle, outside, snapshot }) =>
      Effect.gen(function* () {
        const mutations = makeWikiMutationMethods(
          repository,
          spaces,
          makeWikiListingMethods(repository).read
        )
        const write = (pageId: string) =>
          Effect.gen(function* () {
            const pages = yield* snapshot()
            const record = pages.pages.find((candidate) => candidate.page.pageId === pageId)
            if (record === undefined || pages.head === null) throw new Error(`${pageId} is missing`)
            return yield* mutations
              .update({
                pageId,
                content: page(pageId, "Written by Arden.\n"),
                expectedVersion: record.resource.versionId,
                expectedHead: pages.head,
                authority: GLOBAL_WIKI_LOCATION_AUTHORITY
              })
              .pipe(
                Effect.mapError(outside.explain),
                Effect.match({
                  onFailure: (error) => ({
                    reason: error.reason,
                    message: error.message,
                    retryable: wikiFailure(error).retryable
                  }),
                  onSuccess: () => "saved"
                })
              )
          })
        yield* Effect.promise(async () => {
          await writeFile(join(root, "notes/broken.md"), "---\npage_id: [\n---\nbody\n")
          await writeFile(join(root, "notes/edited.md"), page("edited", "Changed outside.\n"))
        })
        const waiting = yield* write("edited")
        yield* settle()
        return {
          waiting,
          setAside: yield* write("broken"),
          readNotice: outside.state("notes/broken.md")?.kind,
          other: yield* write("kept")
        }
      })
    )
    expect(outcome).toEqual({
      waiting: {
        reason: "blocked",
        message: expect.stringMatching(
          /^notes\/edited\.md was changed outside Arden and Memory has not taken that change in yet\. Nothing was saved\./u
        ),
        retryable: false
      },
      setAside: {
        reason: "blocked",
        message: expect.stringMatching(
          /^notes\/broken\.md was changed outside Arden and Memory set that change aside: .+\. Arden cannot write this page until its file is fixed or put back\.$/u
        ),
        retryable: false
      },
      readNotice: "set_aside",
      other: "saved"
    })
  })
})

describe("one owner for reading files against Memory history", () => {
  it("scans only in wiki/outside-edits.ts, and takes in only through the commit point", () => {
    expect(naming(/\bworkingTreeStatus\b/u)).toEqual(["wiki/outside-edits.ts"])
    expect(naming(/\badoptWorkingChange\b/u)).toEqual(["wiki/commit.ts"])
    expect(naming(/\bcommitOutsideChange\b/u)).toEqual(["wiki/commit.ts", "wiki/outside-edits.ts"])
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
