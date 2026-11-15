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
import { formatWikiPage } from "../src/wiki/page.js"
import { makeWikiRestoreMethods } from "../src/wiki/restore.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { partialService } from "./kit.js"

// The page size limit binds every writer inside Arden at the one commit point. An edit made to
// the files outside Arden is taken in and can be listed as over.

const OWNER: WikiCommitIdentity = {
  actor: "user:desktop",
  origin: { kind: "user", via: "desktop" },
  reason: "owner edit"
}
const REFUSAL = /^me\.md would have 9068 characters, .*Nothing was saved\. Cut at least 68 characters/u

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
  hasPageBinding: () => Effect.succeed(false)
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

/** A write that skips every rule, as older code wrote the over-limit versions still in history. */
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
        yield* unchecked(repository, createPage("me", "me.md", content("me", "Me", "g".repeat(9_400))))
        const write = (operation: (page: ResourceVersion) => WikiPageOperation) =>
          Effect.gen(function* () {
            const page = yield* repository.get("me")
            if (page === null) throw new Error("me.md is missing")
            const head = yield* repository.currentRevision
            return yield* commitWiki(repository, { ...OWNER, expectedRevision: head }, [
              operation(page)
            ]).pipe(
              Effect.match({ onFailure: (error) => error.message, onSuccess: () => "saved" })
            )
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
      longer: expect.stringMatching(/^profile\.md would have 9201 characters, /u)
    })
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
        ) as Effect.Effect<ReadonlyArray<string>>
      )
      expect(pages).toContain("README.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("takes in an outside edit over the limit, and names it as over", async () => {
    const outcome = await withWiki(({ root, listing, mutations }) =>
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
        yield* mutations.observe()
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

/** Who reads a page's limit, and why. Only the commit refuses a write over it. */
const LIMIT_READERS = {
  "memory/core-memory.ts": "asks for condensing before a page is full",
  "memory/retrieval.ts": "sends each limited page to every run, up to its limit",
  "tools/wiki.ts": "shows a page's size against its limit when it is read",
  "wiki/commit.ts": "refuses any write that leaves a page over its limit"
}

it("reads a page's limit only in its listed readers, so no second refusal can appear", () => {
  const readers = sources(SOURCE)
    .map((path) => relative(SOURCE, path))
    .filter((path) => /\bcorePageBudget\(/u.test(readFileSync(join(SOURCE, path), "utf8")))
    .sort()
  expect(readers).toEqual(Object.keys(LIMIT_READERS).sort())
})

it("writes Memory pages only through the commit, or by taking in outside edits", () => {
  const writers = (pattern: RegExp) =>
    sources(SOURCE)
      .map((path) => relative(SOURCE, path))
      .filter((path) => pattern.test(readFileSync(join(SOURCE, path), "utf8")))
  expect(writers(/\brepository\s*\.\s*commit\(/u)).toEqual(["wiki/commit.ts"])
  expect(writers(/\.adoptWorkingChanges\(/u)).toEqual(["wiki/mutations.ts"])
})
