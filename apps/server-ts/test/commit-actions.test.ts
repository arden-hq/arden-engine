import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryShape,
  type ResourceVersion
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import {
  archivePage,
  commitWiki,
  createPage,
  mergePage,
  movePage,
  ownerInApp,
  updatePage,
  type WikiCommitError,
  type WikiCommitIdentity,
  type WikiWrite
} from "../src/wiki/commit.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { formatRedirectPage, formatWikiPage } from "../src/wiki/page.js"
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

const AGENT: WikiCommitIdentity = {
  actor: "Agent",
  origin: { kind: "agent", sessionId: "chat-1" },
  reason: "test"
}

const OWNER_IN_FILE: WikiCommitIdentity = {
  actor: "user:filesystem",
  origin: { kind: "user", via: "filesystem" },
  reason: "test"
}

const commitOutcome = (
  repository: ManagedFileRepositoryShape,
  identity: WikiCommitIdentity,
  write: (page: ResourceVersion) => WikiWrite,
  path: string
) =>
  Effect.gen(function* () {
    const page = yield* repository.findByPath(path)
    if (page === null) throw new Error(`${path} is missing`)
    return yield* commitWiki(
      { repository, spaces },
      { ...identity, expectedRevision: yield* repository.currentRevision },
      [write(page)]
    ).pipe(
      Effect.match({
        onFailure: (error: WikiCommitError) =>
          error._tag === "WikiCommitRuleError" ? error.rule : error._tag,
        onSuccess: () => "saved"
      })
    )
  })

const redirectTo = (page: { readonly resourceId: string; readonly path: string }) => ({
  pageId: page.resourceId,
  title: page.path,
  redirectTo: `id:${SPACE_PAGE}`
})

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

describe("what only one action may do, whatever the writer's call", () => {
  it("lets only a merge turn a page into a redirect, except the owner's own hand merge in the file", async () => {
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        const asEdit = (page: ResourceVersion) =>
          updatePage(page, formatRedirectPage(redirectTo(page)))
        return {
          agentEdit: yield* commitOutcome(repository, AGENT, asEdit, "topics/seeds.md"),
          agentMerge: yield* commitOutcome(
            repository,
            AGENT,
            (page) => mergePage(page, redirectTo(page)),
            "topics/seeds.md"
          ),
          ownerInFile: yield* commitOutcome(repository, OWNER_IN_FILE, asEdit, "topics/README.md")
        }
      })
    )
    expect(outcome).toEqual({ agentEdit: "retire", agentMerge: "saved", ownerInFile: "saved" })
  })

  it("keeps a Space's own page where it is, for every writer, at the commit point", async () => {
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        const retire = {
          archive: archivePage,
          merge: (page: ResourceVersion) => mergePage(page, redirectTo(page)),
          move: (page: ResourceVersion) => movePage(page, "projects/orchard.md")
        }
        const tried: Record<string, string> = {}
        for (const [name, write] of Object.entries(retire)) {
          for (const [writer, identity] of [
            ["agent", AGENT],
            ["owner", ownerInApp("test")]
          ] as const)
            tried[`${writer} ${name}`] = yield* commitOutcome(
              repository,
              identity,
              write,
              SPACE_PAGE
            )
        }
        tried["agent archive of another page"] = yield* commitOutcome(
          repository,
          AGENT,
          archivePage,
          "topics/seeds.md"
        )
        return tried
      })
    )
    expect(outcome).toEqual({
      "agent archive": "space",
      "owner archive": "space",
      "agent merge": "space",
      "owner merge": "space",
      "agent move": "space",
      "owner move": "space",
      "agent archive of another page": "saved"
    })
  })
})

describe("a path or link name taken, at the commit point", () => {
  it("refuses every writer a write that places a page on a name another page holds", async () => {
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        const place = (identity: WikiCommitIdentity, writes: ReadonlyArray<WikiWrite>) =>
          Effect.gen(function* () {
            return yield* commitWiki(
              { repository, spaces },
              { ...identity, expectedRevision: yield* repository.currentRevision },
              writes
            )
          }).pipe(
            Effect.match({
              onFailure: (error: WikiCommitError) =>
                error._tag === "WikiCommitRuleError" ? error.rule : error._tag,
              onSuccess: () => "saved"
            })
          )
        const seeds = yield* repository.findByPath("topics/seeds.md")
        if (seeds === null) throw new Error("topics/seeds.md is missing")
        const readme = "topics/seeds/README.md"
        return {
          "owner create": yield* place(ownerInApp("test"), [
            createPage(`id:${readme}`, readme, content(readme, "Folder."))
          ]),
          "agent create": yield* place(AGENT, [
            createPage(`id:${readme}`, readme, content(readme, "Folder."))
          ]),
          "agent move": yield* place(AGENT, [movePage(seeds, "topics.md")]),
          "two creates on one name": yield* place(ownerInApp("test"), [
            createPage("id:topics/beds.md", "topics/beds.md", content("topics/beds.md", "Beds.")),
            createPage(
              "id:topics/beds/README.md",
              "topics/beds/README.md",
              content("topics/beds/README.md", "Folder.")
            )
          ]),
          "a move onto its own other name": yield* place(AGENT, [movePage(seeds, readme)])
        }
      })
    )
    expect(outcome).toEqual({
      "owner create": "names",
      "agent create": "names",
      "agent move": "names",
      "two creates on one name": "names",
      "a move onto its own other name": "saved"
    })
  })
})
