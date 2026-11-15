import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { baselineStatements } from "../src/persistence/migrations/0001_baseline.js"
import { renameApprovalsStoreWriter } from "../src/persistence/migrations/0168_rename_approvals_store_writer.js"
import { migrations } from "../src/persistence/migrations/index.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { WikiRenameStore } from "../src/persistence/wiki/rename-store.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import {
  commitWiki,
  createPage,
  decodeWikiOrigin,
  ownerInApp,
  upkeepOrigin,
  type WikiCommitIdentity
} from "../src/wiki/commit.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { makeWikiRenameMethods } from "../src/wiki/rename.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { partialService } from "./kit.js"

const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {
  activeBindings: () => Effect.succeed([])
})

const content = (path: string): string =>
  formatWikiPage({
    pageId: `id:${path}`,
    title: path,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body: `${path}.`
  })

const TIDY: WikiCommitIdentity = {
  actor: "Automation builtin-wiki-maintenance",
  origin: upkeepOrigin("builtin-wiki-maintenance"),
  reason: "move a page"
}
const AGENT: WikiCommitIdentity = {
  actor: "Agent",
  origin: { kind: "agent", sessionId: "chat-1" },
  reason: "move a page"
}

describe("a rename keeps the writer that asked for it", () => {
  it("commits an accepted rename as that writer, and opens no second request by another", async () => {
    const root = await mkdtemp(join(tmpdir(), "arden-rename-writer-"))
    try {
      const outcome = await withTempDatabase(
        Effect.gen(function* () {
          const store = yield* WikiRenameStore
          return yield* Effect.gen(function* () {
            const repository = yield* ManagedFileRepository
            yield* commitWiki(
              { repository, spaces },
              { ...ownerInApp("seed"), expectedRevision: null },
              ["topics/README.md", "topics/garden.md"].map((path) =>
                createPage(`id:${path}`, path, content(path))
              )
            )
            const garden = yield* makeWikiListingMethods(repository).read("id:topics/garden.md")
            const renames = makeWikiRenameMethods(repository, spaces, store)
            const request = (commit: WikiCommitIdentity) =>
              renames.requestRename({
                pageId: garden.pageId,
                newPath: "topics/orchard.md",
                newTitle: "Orchard",
                expectedVersion: garden.version,
                expectedHead: garden.repositoryHead,
                authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
                commit
              })
            const asked = yield* request(TIDY)
            const other = yield* request(AGENT).pipe(
              Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "opened" })
            )
            const accepted = yield* renames.acceptRename({ approvalId: asked.approvalId })
            const [renamed] = yield* repository.history({ limit: 1 })
            return {
              other,
              status: accepted.status,
              writer: renamed === undefined ? undefined : decodeWikiOrigin(renamed.origin).kind,
              actor: renamed?.actor
            }
          }).pipe(
            Effect.scoped,
            Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root }))
          )
        })
      )
      expect(outcome).toEqual({
        other: "blocked",
        status: "accepted",
        writer: "upkeep",
        actor: TIDY.actor
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("migration 0168 closes an open approval that kept no writer and keeps every other row", () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false })
    for (const statement of baselineStatements) database.exec(statement)
    for (const migration of migrations.filter(
      (entry) => entry.version < renameApprovalsStoreWriter.version
    ))
      migration.up(database)
    const insert = database.prepare(`INSERT INTO wiki_rename_approvals
      (approval_id, page_id, plan_json, status, created_at, commit_id, resolution)
      VALUES (?, ?, '{}', ?, '2026-11-01T00:00:00.000Z', ?, NULL)`)
    insert.run("pending", "page-a", "pending", null)
    insert.run("applying", "page-b", "applying", null)
    insert.run("accepted", "page-c", "accepted", "commit-c")
    insert.run("rejected", "page-d", "rejected", null)

    renameApprovalsStoreWriter.up(database)

    const rows = database
      .prepare(
        `SELECT approval_id, status, commit_id, writer_json, resolution IS NOT NULL AS resolved
        FROM wiki_rename_approvals ORDER BY approval_id`
      )
      .all()
      .map((row) => ({ ...row }))
    expect(rows).toEqual([
      {
        approval_id: "accepted",
        status: "accepted",
        commit_id: "commit-c",
        writer_json: null,
        resolved: 0
      },
      {
        approval_id: "applying",
        status: "rejected",
        commit_id: null,
        writer_json: null,
        resolved: 1
      },
      {
        approval_id: "pending",
        status: "rejected",
        commit_id: null,
        writer_json: null,
        resolved: 1
      },
      {
        approval_id: "rejected",
        status: "rejected",
        commit_id: null,
        writer_json: null,
        resolved: 0
      }
    ])
    expect(() => insert.run("new", "page-e", "pending", null)).toThrow(/CHECK constraint failed/u)
  })
})
