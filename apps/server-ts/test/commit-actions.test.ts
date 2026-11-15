import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryShape
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import {
  commitWiki,
  createPage,
  ownerInApp,
  updatePage,
  type WikiCommitIdentity
} from "../src/wiki/commit.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { makeWikiRestoreMethods } from "../src/wiki/restore.js"
import { partialService } from "./kit.js"

const content = (path: string, body: string): string =>
  formatWikiPage({
    pageId: `id:${path}`,
    title: path,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body
  })

const SPACE_PAGE = "projects/garden.md"
const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {
  activeBindings: () =>
    Effect.succeed([
      { space_id: "space-garden", page_id: `id:${SPACE_PAGE}`, page_path: SPACE_PAGE }
    ])
})

const CAPTURE: WikiCommitIdentity = {
  actor: "memory:capture",
  origin: { kind: "capture", replayKey: undefined, sessionId: "chat-1" },
  reason: "test"
}

const withMemory = <A>(
  body: (repository: ManagedFileRepositoryShape) => Effect.Effect<A, unknown>
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "arden-commit-actions-")))
      return yield* Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        const save = (path: string, body: string) =>
          Effect.gen(function* () {
            const current = yield* repository.findByPath(path)
            yield* commitWiki(
              { repository, spaces },
              { ...ownerInApp("seed"), expectedRevision: yield* repository.currentRevision },
              [
                current === null
                  ? createPage(`id:${path}`, path, content(path, body))
                  : updatePage(current, content(path, body))
              ]
            )
          })
        for (const path of ["projects/README.md", "topics/README.md"]) yield* save(path, "Folder.")
        for (const path of [SPACE_PAGE, "topics/seeds.md"]) {
          yield* save(path, "First.")
          yield* save(path, "Second.")
        }
        return yield* body(repository)
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })),
        Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true })))
      )
    }) as Effect.Effect<A>
  )

const restoreFirst = (
  repository: ManagedFileRepositoryShape,
  path: string,
  commit: WikiCommitIdentity
) =>
  Effect.gen(function* () {
    const listing = makeWikiListingMethods(repository)
    const restores = makeWikiRestoreMethods(repository, spaces, listing.read)
    const current = yield* repository.findByPath(path)
    if (current === null) throw new Error(`${path} is missing`)
    const history = yield* repository.history({ resourceId: current.resourceId, limit: null })
    const first = history.at(-1)
    if (first === undefined) throw new Error(`${path} has no history`)
    return yield* restores
      .restoreRevision({
        pageId: current.resourceId,
        commitId: first.commitId,
        expectedVersion: current.versionId,
        expectedHead: (yield* repository.currentRevision) ?? "",
        authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
        commit
      })
      .pipe(
        Effect.match({
          onFailure: (error) => `${error.reason}: ${error.message}`,
          onSuccess: () => "saved"
        })
      )
  })

describe("an action the commit point reads from its caller", () => {
  it("refuses Capture an earlier version of a Space's page, at the commit point", async () => {
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        return {
          captureSpacePage: yield* restoreFirst(repository, SPACE_PAGE, CAPTURE),
          captureOtherPage: yield* restoreFirst(repository, "topics/seeds.md", CAPTURE),
          ownerSpacePage: yield* restoreFirst(repository, SPACE_PAGE, ownerInApp("restore"))
        }
      })
    )
    expect(outcome).toEqual({
      captureSpacePage: `blocked: ${SPACE_PAGE} belongs to a Space. Capture does not restore an earlier version of a Space's page. Nothing was saved.`,
      captureOtherPage: "saved",
      ownerSpacePage: "saved"
    })
  })
})
