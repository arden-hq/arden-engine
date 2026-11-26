import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { expect, it } from "vitest"

import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { archivePage, commitWiki, createPage, mergePage, movePage } from "../src/wiki/commit.js"
import { type WikiWrite } from "../src/wiki/commit-write-types.js"
import { ownerInApp, type WikiCommitIdentity } from "../src/wiki/origin.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { partialService } from "./kit.js"

const SPACE_PAGE = "projects/garden.md"
const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {
  activeBindings: () =>
    Effect.succeed([
      { space_id: "space-garden", page_id: `id:${SPACE_PAGE}`, page_path: SPACE_PAGE }
    ])
})
const AGENT: WikiCommitIdentity = {
  actor: "Agent",
  origin: { kind: "agent", sessionId: "chat-1" },
  reason: "test"
}
const content = (path: string) =>
  formatWikiPage({
    pageId: `id:${path}`,
    title: path,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body: "Text."
  })
const page = (path: string) => createPage(`id:${path}`, path, content(path))

it("keeps a Space's own page where it is, and refuses any page a name another page holds, for every writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-commit-actions-"))
  try {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        const commit = (identity: WikiCommitIdentity, writes: ReadonlyArray<WikiWrite>) =>
          Effect.gen(function* () {
            return yield* commitWiki(
              { repository, spaces },
              {
                ...identity,
                authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
                expectedRevision: yield* repository.currentRevision
              },
              writes
            )
          }).pipe(
            Effect.match({
              onFailure: (error) =>
                error._tag === "WikiCommitRuleError" ? error.rule : error._tag,
              onSuccess: () => "saved"
            })
          )
        yield* commit(ownerInApp("seed"), [page(SPACE_PAGE), page("topics/seeds.md")])
        const space = yield* repository.findByPath(SPACE_PAGE)
        if (space === null) throw new Error("space page is missing")
        const redirect = {
          pageId: space.resourceId,
          title: space.path,
          redirectTo: "id:topics/seeds.md"
        }
        const outcome: Record<string, string> = {}
        for (const [writer, identity] of [
          ["agent", AGENT],
          ["owner", ownerInApp("test")]
        ] as const) {
          outcome[`${writer} archive`] = yield* commit(identity, [archivePage(space)])
          outcome[`${writer} merge`] = yield* commit(identity, [mergePage(space, redirect)])
          outcome[`${writer} move`] = yield* commit(identity, [movePage(space, "projects/a.md")])
        }
        outcome["owner create on a taken name"] = yield* commit(ownerInApp("test"), [
          page("topics/Seeds.md")
        ])
        return outcome
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root }))
      ) as Effect.Effect<Record<string, string>>
    )
    expect(Object.values(outcome).filter((rule) => rule === "space")).toHaveLength(6)
    expect(outcome["owner create on a taken name"]).toBe("names")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
