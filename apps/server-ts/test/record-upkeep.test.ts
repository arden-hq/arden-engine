import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { expect, it } from "vitest"

import {
  commitWiki,
  createPage,
  movePage,
  updatePage,
  type WikiCommitOrigin
} from "../src/wiki/commit.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { withoutSpaces } from "./fixtures/wiki-repository.js"

const content = (path: string, body: string, producer?: string) =>
  formatWikiPage({
    pageId: `id:${path}`,
    title: path,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: producer === undefined ? {} : { producer_automation_id: producer },
    body
  })

it("upkeep never edits, creates or moves into a record or folder contract; other writers may", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-records-"))
  try {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        for (const [path, producer] of [
          ["daily/README.md", "auto-daily"],
          ["daily/2026-11-11.md", undefined],
          ["topics/garden.md", undefined]
        ] as const)
          yield* repository.commit({
            actor: "test",
            origin: "test.seed",
            reason: "seed",
            operations: [
              createPage(`id:${path}`, path, content(path, "Text.", producer)).operation
            ],
            expectedHead: yield* repository.currentRevision
          })
        let edits = 0
        const write = (origin: WikiCommitOrigin, path: string, kind: "edit" | "create" | "move") =>
          Effect.gen(function* () {
            const page = yield* repository.findByPath(path)
            if (page === null) throw new Error(`${path} is missing`)
            const operations = {
              edit: () => updatePage(page, content(path, `Rewritten ${(edits += 1)}.`)),
              move: () => movePage(page, "daily/garden.md"),
              create: () =>
                createPage("id:new", "daily/2026-11-12.md", content("daily/2026-11-12.md", "New."))
            }
            const operation = operations[kind]()
            return yield* commitWiki(
              withoutSpaces(repository),
              {
                ...{ actor: origin.kind, origin, reason: "test" },
                authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
                expectedRevision: yield* repository.currentRevision
              },
              [operation]
            ).pipe(
              Effect.match({
                onFailure: (error) =>
                  error._tag === "WikiCommitRuleError" ? error.rule : error._tag,
                onSuccess: () => "saved"
              })
            )
          })
        const upkeep = { kind: "upkeep", automationId: "builtin-wiki-maintenance" } as const
        return {
          record: yield* write(upkeep, "daily/2026-11-11.md", "edit"),
          contract: yield* write(upkeep, "daily/README.md", "edit"),
          created: yield* write(upkeep, "topics/garden.md", "create"),
          movedIn: yield* write(upkeep, "topics/garden.md", "move"),
          knowledge: yield* write(upkeep, "topics/garden.md", "edit"),
          owner: yield* write({ kind: "user", via: "desktop" }, "daily/2026-11-11.md", "edit")
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root }))
      ) as Effect.Effect<Record<string, string>>
    )
    expect(outcome).toEqual({
      record: "records",
      contract: "records",
      created: "records",
      movedIn: "records",
      knowledge: "saved",
      owner: "saved"
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
