import { mkdtemp, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { expect, it } from "vitest"

import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { commitWiki, createPage } from "../src/wiki/commit.js"
import {
  makeOutsideEdits,
  MAX_MISSING_ARCHIVED,
  type OutsideEditCheck
} from "../src/wiki/outside-edits.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { loadSnapshot } from "../src/wiki/snapshot.js"
import { withoutSpaces } from "./fixtures/wiki-repository.js"
import { partialService } from "./kit.js"

const page = (pageId: string) =>
  formatWikiPage({
    pageId,
    title: pageId,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body: `About ${pageId}.\n`
  })

const withMemory = async <A>(
  ids: ReadonlyArray<string>,
  use: (memory: {
    readonly root: string
    readonly settle: () => Effect.Effect<OutsideEditCheck, unknown>
    readonly commits: () => Effect.Effect<number, unknown>
    readonly pageIds: () => Effect.Effect<ReadonlyArray<string>, unknown>
  }) => Effect.Effect<A, unknown>
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "arden-outside-edits-"))
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        yield* commitWiki(
          withoutSpaces(repository),
          {
            actor: "test",
            origin: { kind: "system", name: "test" },
            reason: "seed",
            expectedRevision: null
          },
          ids.map((id) => createPage(id, `notes/${id}.md`, page(id)))
        )
        const outside = makeOutsideEdits({
          repository,
          spaces: partialService<SpaceStore["Service"]>("SpaceStore", {
            activeBindings: () => Effect.succeed([])
          }),
          snapshot: () => loadSnapshot(repository, "list")
        })
        return yield* use({
          root,
          settle: () => outside.check().pipe(Effect.andThen(outside.check())),
          commits: () => repository.history().pipe(Effect.map((history) => history.length)),
          pageIds: () =>
            loadSnapshot(repository, "list").pipe(
              Effect.map((snapshot) => snapshot.pages.map((record) => record.page.pageId))
            )
        })
      }).pipe(Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })))
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it("a page whose file moved is set aside, not archived", async () => {
  const result = await withMemory(["kept"], ({ root, settle, pageIds }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => rename(join(root, "notes/kept.md"), join(root, "kept-moved.md")))
      const checked = yield* settle()
      return { setAside: checked.setAside.map((item) => item.reason), inMemory: yield* pageIds() }
    })
  )
  expect(result).toEqual({ setAside: ["moved"], inMemory: ["kept"] })
})

it("archives none when more pages are missing at once than one check archives", async () => {
  const ids = Array.from({ length: MAX_MISSING_ARCHIVED + 1 }, (_, index) => `many-${index}`)
  const added = await withMemory(ids, ({ root, settle, commits }) =>
    Effect.gen(function* () {
      const before = yield* commits()
      yield* Effect.promise(() => rm(join(root, "notes"), { recursive: true }))
      yield* settle()
      return (yield* commits()) - before
    })
  )
  expect(added).toBe(0)
})
