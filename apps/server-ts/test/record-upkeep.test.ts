import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryShape
} from "@arden-hq/revisions/effect"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  commitWiki,
  createPage,
  decodeWikiOrigin,
  movePage,
  updatePage,
  type WikiCommitOrigin
} from "../src/wiki/commit.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { makeWikiRestoreMethods } from "../src/wiki/restore.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import type { ChatRunRecord } from "../src/persistence/runs/model.js"
import type { RunQueries } from "../src/persistence/runs/queries.js"
import { writeIdentity } from "../src/tools/wiki-identity.js"
import { partialService, runAuthority } from "./kit.js"

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

const UPKEEP: WikiCommitOrigin = { kind: "upkeep", automationId: "builtin-wiki-maintenance" }

describe("upkeep never edits a record or a folder contract", () => {
  const run = <A>(body: (repository: ManagedFileRepositoryShape) => Effect.Effect<A, unknown>) =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "arden-records-")))
      return yield* Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        return yield* body(repository)
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })),
        Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true })))
      )
    })

  const write = (
    repository: ManagedFileRepositoryShape,
    origin: WikiCommitOrigin,
    operation: (
      pages: Map<string, { resourceId: string; versionId: string }>
    ) => ReturnType<typeof updatePage>
  ) =>
    Effect.gen(function* () {
      const pages = new Map(
        (yield* repository.listResources()).map((resource) => [resource.path, resource] as const)
      )
      return yield* commitWiki(
        repository,
        {
          actor: origin.kind,
          origin,
          reason: "test write",
          expectedRevision: yield* repository.currentRevision
        },
        [operation(pages)]
      ).pipe(
        Effect.match({
          onFailure: (error) => (error._tag === "WikiCommitRuleError" ? error.rule : error._tag),
          onSuccess: () => "saved"
        })
      )
    })

  const seeded = (repository: ManagedFileRepositoryShape) =>
    Effect.gen(function* () {
      for (const [path, body, producer] of [
        ["daily/README.md", "Daily notes.", "auto-daily"],
        ["daily/2026-11-11.md", "A report.", undefined],
        ["topics/garden.md", "Garden.", undefined],
        ["topics/README.md", "Topics.", undefined]
      ] as const)
        yield* repository.commit({
          actor: "test",
          origin: "test.seed",
          reason: "seed",
          operations: [createPage(`id:${path}`, path, content(path, body, producer))],
          expectedHead: yield* repository.currentRevision
        })
    })

  it("refuses upkeep's edit, creation or move of a record or contract at the commit point", async () => {
    const outcome = await Effect.runPromise(
      run((repository) =>
        Effect.gen(function* () {
          yield* seeded(repository)
          let edits = 0
          const edit =
            (path: string) => (pages: Map<string, { resourceId: string; versionId: string }>) => {
              const resource = pages.get(path)
              if (resource === undefined) throw new Error(`${path} is missing`)
              edits += 1
              return updatePage(resource, content(path, `Rewritten ${edits} times.`))
            }
          return {
            record: yield* write(repository, UPKEEP, edit("daily/2026-11-11.md")),
            contract: yield* write(repository, UPKEEP, edit("daily/README.md")),
            created: yield* write(repository, UPKEEP, () =>
              createPage("id:new", "daily/2026-11-12.md", content("daily/2026-11-12.md", "New."))
            ),
            movedIn: yield* write(repository, UPKEEP, (pages) => {
              const resource = pages.get("topics/garden.md")
              if (resource === undefined) throw new Error("topics/garden.md is missing")
              return movePage(resource, "daily/garden.md")
            }),
            knowledge: yield* write(repository, UPKEEP, edit("topics/garden.md")),
            owner: yield* write(
              repository,
              { kind: "user", via: "desktop" },
              edit("daily/2026-11-11.md")
            ),
            chat: yield* write(
              repository,
              { kind: "agent", sessionId: "chat-1" },
              edit("daily/2026-11-11.md")
            ),
            ownersAutomation: yield* write(
              repository,
              { kind: "automation", automationId: "auto-owner" },
              edit("daily/2026-11-11.md")
            )
          }
        })
      )
    )
    expect(outcome).toEqual({
      record: "records",
      contract: "records",
      created: "records",
      movedIn: "records",
      knowledge: "saved",
      owner: "saved",
      chat: "saved",
      ownersAutomation: "saved"
    })
  })
})

describe("the upkeep writer", () => {
  const at = DateTime.makeUnsafe("2026-11-01T10:00:00Z")
  const origin = (automationId: string) =>
    writeIdentity(
      partialService<RunQueries["Service"]>("RunQueries", {
        get: (runId): Effect.Effect<ChatRunRecord> =>
          Effect.succeed({
            runId,
            sessionId: "session-1",
            turnId: "turn",
            status: "running",
            stopReason: null,
            startedAt: at,
            updatedAt: at,
            endedAt: null,
            lastSequence: null,
            metadata: {
              run_context: {
                origin: { kind: "automation", automation_id: automationId, occurrence_id: "o1" },
                task: null
              }
            },
            errorCode: null,
            errorMessage: null,
            clientId: null,
            modelId: null,
            reasoningEffort: null
          }),
        cause: () => Effect.succeed({ automationId, wakeDepth: 1 })
      }),
      {
        runId: "run-1",
        sessionId: "session-1",
        signal: new AbortController().signal,
        authority: runAuthority()
      }
    ).then((identity) => identity.origin)

  it("is Tidy's run, told apart by the system handler registry", async () => {
    expect([await origin("builtin-wiki-maintenance"), await origin("auto-owner")]).toEqual([
      { kind: "upkeep", automationId: "builtin-wiki-maintenance", chainDepth: 1 },
      { kind: "automation", automationId: "auto-owner", chainDepth: 1 }
    ])
  })
})

describe("Tidy's stored writes", () => {
  it("read back as upkeep, as stored now and in both retired spellings", () => {
    expect([
      decodeWikiOrigin("wiki.upkeep.builtin-wiki-maintenance~2"),
      decodeWikiOrigin("wiki.automation.builtin-wiki-maintenance~2"),
      decodeWikiOrigin("wiki.automation.builtin-wiki-maintenance"),
      decodeWikiOrigin("wiki.maintenance"),
      decodeWikiOrigin("wiki.automation.auto-owner~1")
    ]).toEqual([
      { kind: "upkeep", automationId: "builtin-wiki-maintenance", chainDepth: 2 },
      { kind: "upkeep", automationId: "builtin-wiki-maintenance", chainDepth: 2 },
      { kind: "upkeep", automationId: "builtin-wiki-maintenance" },
      { kind: "upkeep", automationId: "builtin-wiki-maintenance" },
      { kind: "automation", automationId: "auto-owner", chainDepth: 1 }
    ])
  })

  it("can be undone by the owner from the app", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "arden-tidy-undo-")))
        return yield* Effect.gen(function* () {
          const repository = yield* ManagedFileRepository
          const page = "topics/garden.md"
          yield* commitWiki(
            repository,
            {
              actor: "test",
              origin: { kind: "user", via: "desktop" },
              reason: "seed",
              expectedRevision: null
            },
            [createPage(`id:${page}`, page, content(page, "Garden."))]
          )
          const before = yield* repository.get(`id:${page}`)
          if (before === null) return yield* Effect.die(`${page} is missing`)
          const tidied = yield* commitWiki(
            repository,
            {
              actor: "Automation builtin-wiki-maintenance",
              origin: UPKEEP,
              reason: "tidy",
              expectedRevision: yield* repository.currentRevision
            },
            [updatePage(before, content(page, "Garden, tidied."))]
          )
          const after = yield* repository.get(`id:${page}`)
          const listing = makeWikiListingMethods(repository)
          const restores = makeWikiRestoreMethods(
            repository,
            partialService<SpaceStore["Service"]>("SpaceStore", {
              activeBindings: () => Effect.succeed([])
            }),
            listing.read
          )
          return yield* restores
            .restore({
              pageId: `id:${page}`,
              commitId: tidied.commit.commitId,
              expectedVersion: after?.versionId ?? "",
              expectedHead: tidied.commit.commitId,
              commit: {
                actor: "user:desktop",
                origin: { kind: "user", via: "desktop" },
                reason: "undo"
              }
            })
            .pipe(
              Effect.match({
                onFailure: (error) => error.message,
                onSuccess: (restored) => restored.content.includes("Garden, tidied.")
              })
            )
        }).pipe(
          Effect.scoped,
          Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })),
          Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true })))
        )
      })
    )
    expect(outcome).toBe(false)
  })
})
