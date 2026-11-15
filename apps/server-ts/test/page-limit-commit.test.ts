import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryShape,
  type ResourceVersion
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { initializeWikiFoundation } from "../src/wiki/foundation.js"
import {
  archivePage,
  commitWiki,
  createPage,
  movePage,
  overPageLimit,
  updatePage,
  type WikiCommitIdentity,
  type WikiPageOperation
} from "../src/wiki/commit.js"
import type { WikiError } from "../src/wiki/errors.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { makeWikiMutationMethods } from "../src/wiki/mutations.js"
import { makeOutsideEdits } from "../src/wiki/outside-edits.js"
import * as coreMemory from "../src/memory/core-memory.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { makeWikiRestoreMethods } from "../src/wiki/restore.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { partialService } from "./kit.js"

const OWNER: WikiCommitIdentity = {
  actor: "user:desktop",
  origin: { kind: "user", via: "desktop" },
  reason: "owner edit"
}
const REFUSAL =
  /^me\.md would have 9068 characters; its limit is 9000, .*Nothing was saved\. Shorten it by at least 68 characters\.$/u
const AGENT: WikiCommitIdentity = {
  actor: "agent:test",
  origin: { kind: "agent", sessionId: undefined },
  reason: "agent edit"
}

const content = (pageId: string, title: string, body: string) =>
  formatWikiPage({
    pageId,
    title,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body
  })

const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {
  activeBindings: () => Effect.succeed([])
})

const withWiki = async <A>(
  body: (wiki: {
    readonly root: string
    readonly repository: ManagedFileRepositoryShape
    readonly listing: ReturnType<typeof makeWikiListingMethods>
    readonly mutations: ReturnType<typeof makeWikiMutationMethods>
    readonly restores: ReturnType<typeof makeWikiRestoreMethods>
  }) => Effect.Effect<A, unknown>
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "arden-page-limit-"))
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        yield* unchecked(
          repository,
          createPage("root", "README.md", content("root", "Memory", "Pages."))
        )
        const listing = makeWikiListingMethods(repository)
        return yield* body({
          root,
          repository,
          listing,
          mutations: makeWikiMutationMethods(repository, spaces, listing.read),
          restores: makeWikiRestoreMethods(repository, spaces, listing.read)
        })
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root }))
      ) as Effect.Effect<A>
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const unchecked = (repository: ManagedFileRepositoryShape, operation: WikiPageOperation) =>
  Effect.gen(function* () {
    const head = yield* repository.currentRevision
    return yield* repository.commit({
      actor: "test",
      origin: "test.unchecked",
      reason: "write past the rules",
      operations: [operation],
      expectedHead: head
    })
  })

const refusal = <A>(effect: Effect.Effect<A, WikiError>) =>
  Effect.match(effect, {
    onFailure: (error): WikiError | undefined => error,
    onSuccess: () => undefined
  })

describe("the page size limit at the commit", () => {
  it("refuses the owner's app edit, a restore of an old version and of an archived page", async () => {
    const outcome = await withWiki(({ repository, listing, mutations, restores }) =>
      Effect.gen(function* () {
        const me = yield* mutations.create({
          path: "me.md",
          title: "Me",
          body: "Short profile.",
          authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
          commit: OWNER
        })
        const appEdit = yield* refusal(
          mutations.update({
            pageId: me.pageId,
            content: content(me.pageId, "Me", "a".repeat(9_068)),
            expectedVersion: me.version,
            expectedHead: (yield* listing.head()) ?? "",
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
            commit: OWNER
          })
        )
        const atLimit = yield* mutations.update({
          pageId: me.pageId,
          content: content(me.pageId, "Me", "a".repeat(9_000)),
          expectedVersion: me.version,
          expectedHead: (yield* listing.head()) ?? "",
          authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
          commit: OWNER
        })

        const before = yield* repository.get(me.pageId)
        if (before === null) throw new Error("me.md is missing")
        const over = yield* unchecked(
          repository,
          updatePage(before, content(me.pageId, "Me", "b".repeat(9_068)))
        )
        const overVersion = yield* repository.get(me.pageId)
        if (overVersion === null) throw new Error("me.md is missing")
        yield* unchecked(repository, updatePage(overVersion, content(me.pageId, "Me", "Short.")))
        const current = yield* listing.read(me.pageId)
        const restore = yield* refusal(
          restores.restoreRevision({
            pageId: me.pageId,
            commitId: over.commit.commitId,
            expectedVersion: current.version,
            expectedHead: (yield* listing.head()) ?? "",
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
            commit: OWNER
          })
        )

        const shortVersion = yield* repository.get(me.pageId)
        if (shortVersion === null) throw new Error("me.md is missing")
        yield* unchecked(
          repository,
          updatePage(shortVersion, content(me.pageId, "Me", "c".repeat(9_068)))
        )
        const big = yield* repository.get(me.pageId)
        if (big === null) throw new Error("me.md is missing")
        yield* unchecked(repository, archivePage(big))
        const archived = yield* repository.get(me.pageId)
        if (archived === null) throw new Error("me.md is missing")
        const unarchive = yield* refusal(
          restores.restoreArchived({
            pageId: me.pageId,
            expectedVersion: archived.versionId,
            expectedHead: (yield* listing.head()) ?? "",
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY
          })
        )
        return {
          appEdit: appEdit?.message,
          atLimit: atLimit.content.length > 9_000,
          restore: restore?.message,
          unarchive: unarchive?.message
        }
      })
    )
    expect(outcome.appEdit).toMatch(REFUSAL)
    expect(outcome.atLimit).toBe(true)
    expect(outcome.restore).toMatch(REFUSAL)
    expect(outcome.unarchive).toMatch(REFUSAL)
  })

  it("refuses a move onto a limited path, with or without new text", async () => {
    const outcome = await withWiki(({ repository }) =>
      Effect.gen(function* () {
        yield* unchecked(
          repository,
          createPage("big", "topics/big.md", content("big", "Big", "d".repeat(9_068)))
        )
        const big = yield* repository.get("big")
        if (big === null) throw new Error("topics/big.md is missing")
        const write = (operation: WikiPageOperation) =>
          repository.currentRevision.pipe(
            Effect.flatMap((head) =>
              commitWiki(repository, { ...OWNER, expectedRevision: head }, [operation])
            ),
            Effect.flip,
            Effect.map((error) => error.message)
          )
        return {
          move: yield* write(movePage(big, "me.md")),
          moveWithText: yield* write(
            movePage(big, "me.md", content("big", "Big", "e".repeat(9_068)))
          ),
          create: yield* write(createPage("new", "me.md", content("new", "Me", "f".repeat(9_068))))
        }
      })
    )
    expect(outcome).toEqual({
      move: expect.stringMatching(REFUSAL),
      moveWithText: expect.stringMatching(REFUSAL),
      create: expect.stringMatching(REFUSAL)
    })
  })

  it("lets a write through that does not grow a page already over its limit", async () => {
    const outcome = await withWiki(({ repository }) =>
      Effect.gen(function* () {
        yield* unchecked(
          repository,
          createPage("me", "me.md", content("me", "Me", "g".repeat(9_400)))
        )
        const write = (operation: (page: ResourceVersion) => WikiPageOperation) =>
          Effect.gen(function* () {
            const page = yield* repository.get("me")
            if (page === null) throw new Error("me.md is missing")
            const head = yield* repository.currentRevision
            return yield* commitWiki(repository, { ...OWNER, expectedRevision: head }, [
              operation(page)
            ]).pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "saved" }))
          })
        return {
          shorter: yield* write((page) => updatePage(page, content("me", "Me", "g".repeat(9_200)))),
          retitled: yield* write((page) =>
            updatePage(page, content("me", "Profile", "g".repeat(9_200)))
          ),
          moved: yield* write((page) => movePage(page, "profile.md")),
          longer: yield* write((page) => updatePage(page, content("me", "Me", "g".repeat(9_201))))
        }
      })
    )
    expect(outcome).toEqual({
      shorter: "saved",
      retitled: "saved",
      moved: "saved",
      longer: expect.stringMatching(/^profile\.md would have 9201 characters; its limit is 9000/u)
    })
  })

  it("tells a model writer how to condense, and the owner only what to shorten", async () => {
    const outcome = await withWiki(({ repository }) =>
      Effect.gen(function* () {
        const write = (identity: WikiCommitIdentity) =>
          repository.currentRevision.pipe(
            Effect.flatMap((head) =>
              commitWiki(repository, { ...identity, expectedRevision: head }, [
                createPage("me", "me.md", content("me", "Me", "h".repeat(9_068)))
              ])
            ),
            Effect.flip,
            Effect.map((error) => error.message)
          )
        return { owner: yield* write(OWNER), agent: yield* write(AGENT) }
      })
    )
    expect(outcome.owner).toMatch(REFUSAL)
    expect(outcome.owner).not.toMatch(/retry|Trimming/u)
    expect(outcome.agent).toMatch(
      /^me\.md would have 9068 characters, but it is sent whole to every run .*Cut at least 68 characters; aim for 7200 or fewer .*Then retry with the new fact included\.$/u
    )
  })

  it("replays a landed commit under its key even when the page has changed since", async () => {
    const outcome = await withWiki(({ repository }) =>
      Effect.gen(function* () {
        yield* unchecked(
          repository,
          createPage("me", "me.md", content("me", "Me", "i".repeat(9_600)))
        )
        const over = yield* repository.get("me")
        if (over === null) throw new Error("me.md is missing")
        const head = yield* repository.currentRevision
        const batch = (expected: ResourceVersion) =>
          commitWiki(
            repository,
            {
              actor: "memory:capture",
              origin: { kind: "capture", replayKey: "capture-batch-1", sessionId: undefined },
              reason: "capture",
              expectedRevision: head
            },
            [updatePage(expected, content("me", "Me", "i".repeat(9_400)))]
          ).pipe(
            Effect.match({
              onFailure: (error) => error.message,
              onSuccess: (result) => (result.replayed ? "replayed" : "saved")
            })
          )
        const first = yield* batch(over)
        const shortened = yield* repository.get("me")
        if (shortened === null) throw new Error("me.md is missing")
        yield* commitWiki(
          repository,
          { ...OWNER, expectedRevision: yield* repository.currentRevision },
          [updatePage(shortened, content("me", "Me", "Short."))]
        )
        return { first, retried: yield* batch(over) }
      })
    )
    expect(outcome).toEqual({ first: "saved", retried: "replayed" })
  })

  it("commits the seed pages of a fresh Memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "arden-page-limit-seed-"))
    try {
      const pages = await Effect.runPromise(
        Effect.gen(function* () {
          const repository = yield* ManagedFileRepository
          yield* initializeWikiFoundation(repository, { workingRoot: root })
          return (yield* repository.listResources()).map((resource) => resource.path).sort()
        }).pipe(
          Effect.scoped,
          Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root }))
        ) as unknown as Effect.Effect<ReadonlyArray<string>>
      )
      expect(pages).toContain("README.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("takes in an outside edit over the limit, and names it as over", async () => {
    const outcome = await withWiki(({ root, repository, listing, mutations }) =>
      Effect.gen(function* () {
        const me = yield* mutations.create({
          path: "me.md",
          title: "Me",
          body: "Short profile.",
          authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
          commit: OWNER
        })
        const file = join(root, "me.md")
        const text = yield* Effect.promise(() => readFile(file, "utf8"))
        yield* Effect.promise(() =>
          writeFile(file, text.replace("Short profile.", "g".repeat(9_068)))
        )
        const outside = makeOutsideEdits({ repository, spaces, snapshot: listing.snapshot })
        yield* outside.check()
        const settled = yield* outside.check()
        expect(settled.takenIn.map((item) => [item.path, item.action])).toEqual([
          ["me.md", "update"]
        ])
        const record = (yield* listing.snapshot()).pages.find(
          (page) => page.page.pageId === me.pageId
        )
        if (record === undefined) throw new Error("me.md is missing")
        return overPageLimit({
          path: record.resource.path,
          pageId: record.page.pageId,
          body: record.page.body
        })
      })
    )
    expect(outcome).toEqual({ chars: 9_068, limit: 9_000 })
  })
})

const SOURCE = join(import.meta.dirname, "../src")

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

const LIMIT_READERS = {
  "context/memory-context.ts": "sizes the standing-facts allowance to hold a page at its limit",
  "memory/core-memory.ts": "asks for condensing before a page is full",
  "memory/retrieval.ts": "cuts a page past its limit when it is sent",
  "tools/wiki.ts": "shows a page's size against its limit when it is read",
  "wiki/commit.ts": "refuses any write that grows a page past its limit"
}

it("reads a page's limit only in its listed readers, so no second refusal can appear", () => {
  const readers = sources(SOURCE)
    .map((path) => relative(SOURCE, path))
    .filter((path) => /\bcorePageBudget\(/u.test(readFileSync(join(SOURCE, path), "utf8")))
  expect(readers).toContain("wiki/commit.ts")
  expect(readers.filter((path) => !(path in LIMIT_READERS))).toEqual([])
  expect(Object.values(coreMemory).filter((value) => typeof value === "number")).toEqual([])
})

const MEMORY_WRITERS = [
  { method: /\brepository\s*\.\s*commit\(/u, file: "wiki/commit.ts" },
  { method: /\.adoptWorkingChanges?\(/u, file: "wiki/commit.ts" },
  { method: /\.restoreFromCommit\(/u, file: undefined }
]

it("writes Memory pages only through the commit, or by taking in outside edits", () => {
  const callers = (pattern: RegExp) =>
    sources(SOURCE)
      .map((path) => relative(SOURCE, path))
      .filter((path) => pattern.test(readFileSync(join(SOURCE, path), "utf8")))
  for (const writer of MEMORY_WRITERS)
    expect(callers(writer.method)).toEqual(writer.file === undefined ? [] : [writer.file])
})
