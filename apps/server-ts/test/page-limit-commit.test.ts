import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { commitWiki, createPage, updatePage } from "../src/wiki/commit.js"
import { ownerInApp } from "../src/wiki/origin.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { withoutSpaces } from "./fixtures/wiki-repository.js"

const content = (title: string, size: number) =>
  formatWikiPage({
    pageId: "me",
    title,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body: "g".repeat(size)
  })

it("refuses a write that grows a page past its size limit, but not one that leaves an over-limit page no longer", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-page-limit-"))
  try {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        yield* repository.commit({
          actor: "test",
          origin: "test.unchecked",
          reason: "write past the rules",
          operations: [createPage("me", "me.md", content("Me", 9_400)).operation],
          expectedHead: yield* repository.currentRevision
        })
        const write = (title: string, size: number) =>
          Effect.gen(function* () {
            const page = yield* repository.get("me")
            if (page === null) throw new Error("me.md is missing")
            return yield* commitWiki(
              withoutSpaces(repository),
              {
                ...ownerInApp("test"),
                authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
                expectedRevision: yield* repository.currentRevision
              },
              [updatePage(page, content(title, size))]
            ).pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "saved" }))
          })
        return {
          shorter: yield* write("Me", 9_200),
          longer: yield* write("Me", 9_201),
          same: yield* write("Me too", 9_200)
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root }))
      ) as Effect.Effect<Record<"shorter" | "longer" | "same", string>>
    )
    expect(outcome.shorter).toBe("saved")
    expect(outcome.longer).not.toBe("saved")
    expect(outcome.same).toBe("saved")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
