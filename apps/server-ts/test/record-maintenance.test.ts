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

import { PROMPT_TEXT } from "../src/prompts/catalog.js"
import { archivePage, createPage, type WikiPageOperation } from "../src/wiki/commit.js"
import { makeWikiMaintenanceMethods } from "../src/wiki/maintenance.js"
import { formatWikiPage } from "../src/wiki/page.js"

// Made-up pages; nothing here comes from anyone's Memory.

const content = (path: string, body: string, producer?: string): string =>
  formatWikiPage({
    pageId: `id:${path}`,
    title: path,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: producer === undefined ? {} : { producer_automation_id: producer },
    body
  })

const create = (path: string, body: string, producer?: string) =>
  createPage(`id:${path}`, path, content(path, body, producer))

const commit = (repository: ManagedFileRepositoryShape, operation: WikiPageOperation) =>
  Effect.gen(function* () {
    return (yield* repository.commit({
      actor: "test",
      origin: "desktop",
      reason: "test change",
      operations: [operation],
      expectedHead: yield* repository.currentRevision
    })).commit.commitId
  })

/** The Maintenance brief for the changes made by `changes` after the seed. */
const brief = (
  changes: (repository: ManagedFileRepositoryShape) => Effect.Effect<unknown, unknown>
): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "arden-record-review-")))
      return yield* Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        for (const operation of [
          create("README.md", "Memory."),
          create("topics/README.md", "Topics."),
          create("topics/garden.md", "Garden. See [[daily/2026-11-12.md|the day]]."),
          create("daily/README.md", "Daily notes.", "auto-daily"),
          create("imported/README.md", "Imported notes.")
        ])
          yield* commit(repository, operation)
        const processedHead = yield* repository.currentRevision
        yield* changes(repository)
        const prepared = yield* makeWikiMaintenanceMethods(repository).prepare({
          processedHead
        })
        return prepared.kind === "review" ? prepared.markdown : prepared.kind
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })),
        Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true })))
      )
    }) as Effect.Effect<string>
  )

describe("Tidy and records", () => {
  it("reviews a new report, and names records and contracts as read only", async () => {
    const markdown = await brief((repository) =>
      commit(repository, create("daily/2026-11-12.md", "What happened."))
    )
    expect(markdown).toContain("### Revision")
    expect(markdown).toMatch(/: create daily\/2026-11-12\.md \(record; read only\)$/mu)
    expect(markdown).toMatch(/^- daily\/2026-11-12\.md — .* \(record; read only\)$/mu)
    expect(markdown).toMatch(/^- topics\/garden\.md — topics\/garden\.md$/mu)
  })

  it("leaves imported notes out of review by their path, with or without the folder's README", async () => {
    const imported = await brief((repository) =>
      commit(repository, create("imported/notes.md", "An imported note."))
    )
    const unfoldered = await brief((repository) =>
      Effect.gen(function* () {
        const resource = yield* repository.findByPath("imported/README.md")
        if (resource === null) throw new Error("imported/README.md is missing")
        yield* commit(repository, archivePage(resource))
        yield* commit(repository, create("imported/notes.md", "An imported note."))
      })
    )
    expect(imported).toBe("advance")
    expect(unfoldered).not.toMatch(/imported\/notes\.md/u)
  })

  it("is not told to change a field only records carry", () => {
    expect(PROMPT_TEXT.wikiMaintenance).not.toMatch(/observation_period/u)
  })
})
