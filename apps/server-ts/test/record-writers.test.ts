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

import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import {
  archivePage,
  commitWiki,
  createPage,
  movePage,
  updatePage,
  type WikiCommitOrigin,
  type WikiPageOperation
} from "../src/wiki/commit.js"
import type { WikiError } from "../src/wiki/errors.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { makeWikiMutationMethods } from "../src/wiki/mutations.js"
import { formatRedirectPage, formatWikiPage } from "../src/wiki/page.js"
import { makeWikiRenameMethods } from "../src/wiki/rename.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import type { WikiRenameStore } from "../src/persistence/wiki/rename-store.js"
import { partialService } from "./kit.js"

// Made-up pages; nothing here comes from anyone's Memory.

const CONTRACT = [
  "## Purpose",
  "Made-up pages.",
  "## Producers",
  "A made-up writer.",
  "## Consumers",
  "Tests.",
  "## Boundaries",
  "None.",
  "## Retention",
  "Keep."
].join("\n\n")

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

const SEED: ReadonlyArray<readonly [string, string, string?]> = [
  ["README.md", "Memory."],
  ["notes.md", "A page at the root."],
  ["daily/README.md", CONTRACT, "auto-daily"],
  ["daily/2026-11-11.md", "A report."],
  ["topics/README.md", CONTRACT],
  ["topics/garden.md", "Garden."],
  ["topics/seeds.md", "Seeds."]
]

const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {
  hasPageBinding: () => Effect.succeed(false),
  ownsWikiPath: () => Effect.succeed(false)
})

const withMemory = <A>(
  body: (repository: ManagedFileRepositoryShape) => Effect.Effect<A, unknown>,
  seed: ReadonlyArray<readonly [string, string, string?]> = SEED
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "arden-record-writers-")))
      return yield* Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        for (const [path, text, producer] of seed)
          yield* repository.commit({
            actor: "test",
            origin: "test.seed",
            reason: "seed",
            operations: [createPage(`id:${path}`, path, content(path, text, producer))],
            expectedHead: yield* repository.currentRevision
          })
        return yield* body(repository)
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })),
        Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true })))
      )
    }) as Effect.Effect<A>
  )

type Pages = ReadonlyMap<string, { readonly resourceId: string; readonly versionId: string }>

const page = (pages: Pages, path: string) => {
  const resource = pages.get(path)
  if (resource === undefined) throw new Error(`${path} is missing`)
  return resource
}

/** Commits one operation as `origin` and says which rule refused it, or "saved". */
const write = (
  repository: ManagedFileRepositoryShape,
  origin: WikiCommitOrigin,
  operation: (pages: Pages) => WikiPageOperation
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

const OWNER: WikiCommitOrigin = { kind: "user", via: "desktop" }
const PRODUCER: WikiCommitOrigin = { kind: "automation", automationId: "auto-daily" }
const OTHER_AUTOMATION: WikiCommitOrigin = { kind: "automation", automationId: "auto-other" }
const CAPTURE: WikiCommitOrigin = { kind: "capture", replayKey: undefined, sessionId: undefined }

const redirect = (path: string, to: string) =>
  formatRedirectPage({ pageId: `id:${path}`, title: path, redirectTo: `id:${to}` })

describe("the record rules for writers, at the commit point", () => {
  it("lets only a folder's producer add a page to it, among automated writers", async () => {
    const created = (origin: WikiCommitOrigin, path: string) => () =>
      createPage(`id:${path}`, path, content(path, "New."))
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        return {
          otherAutomation: yield* write(
            repository,
            OTHER_AUTOMATION,
            created(OTHER_AUTOMATION, "daily/2026-11-12.md")
          ),
          capture: yield* write(repository, CAPTURE, created(CAPTURE, "daily/2026-11-13.md")),
          producer: yield* write(repository, PRODUCER, created(PRODUCER, "daily/2026-11-14.md")),
          owner: yield* write(repository, OWNER, created(OWNER, "daily/2026-11-15.md")),
          knowledge: yield* write(
            repository,
            OTHER_AUTOMATION,
            created(OTHER_AUTOMATION, "topics/new.md")
          )
        }
      })
    )
    expect(outcome).toEqual({
      otherAutomation: "records",
      capture: "records",
      producer: "saved",
      owner: "saved",
      knowledge: "saved"
    })
  })

  it("moves no page into a record folder, and no automated writer moves a record out", async () => {
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        return {
          ownerIn: yield* write(repository, OWNER, (pages) =>
            movePage(page(pages, "topics/garden.md"), "daily/garden.md")
          ),
          producerIn: yield* write(repository, PRODUCER, (pages) =>
            movePage(page(pages, "topics/garden.md"), "daily/garden.md")
          ),
          automationOut: yield* write(repository, OTHER_AUTOMATION, (pages) =>
            movePage(page(pages, "daily/2026-11-11.md"), "topics/day.md")
          ),
          ownerOut: yield* write(repository, OWNER, (pages) =>
            movePage(page(pages, "daily/2026-11-11.md"), "topics/day.md")
          )
        }
      })
    )
    expect(outcome).toEqual({
      ownerIn: "records",
      producerIn: "records",
      automationOut: "records",
      ownerOut: "saved"
    })
  })

  it("lets no automated writer archive or merge away a record or a contract", async () => {
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        return {
          archiveRecord: yield* write(repository, OTHER_AUTOMATION, (pages) =>
            archivePage(page(pages, "daily/2026-11-11.md"))
          ),
          archiveContract: yield* write(repository, PRODUCER, (pages) =>
            archivePage(page(pages, "daily/README.md"))
          ),
          mergeRecord: yield* write(repository, CAPTURE, (pages) =>
            updatePage(
              page(pages, "daily/2026-11-11.md"),
              redirect("daily/2026-11-11.md", "topics/garden.md")
            )
          ),
          updateRecord: yield* write(repository, OTHER_AUTOMATION, (pages) =>
            updatePage(
              page(pages, "daily/2026-11-11.md"),
              content("daily/2026-11-11.md", "A corrected report.")
            )
          ),
          ownerArchive: yield* write(repository, OWNER, (pages) =>
            archivePage(page(pages, "daily/2026-11-11.md"))
          )
        }
      })
    )
    expect(outcome).toEqual({
      archiveRecord: "records",
      archiveContract: "records",
      mergeRecord: "records",
      updateRecord: "saved",
      ownerArchive: "saved"
    })
  })

  it("lets no automated writer retire a root page or merge again a page merged and restored", async () => {
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        const archiveRoot = yield* write(repository, OTHER_AUTOMATION, (pages) =>
          archivePage(page(pages, "notes.md"))
        )
        yield* write(repository, OWNER, (pages) =>
          updatePage(
            page(pages, "topics/seeds.md"),
            redirect("topics/seeds.md", "topics/garden.md")
          )
        )
        yield* write(repository, OWNER, (pages) =>
          updatePage(page(pages, "topics/seeds.md"), content("topics/seeds.md", "Seeds."))
        )
        return {
          archiveRoot,
          mergeAgain: yield* write(repository, CAPTURE, (pages) =>
            updatePage(
              page(pages, "topics/seeds.md"),
              redirect("topics/seeds.md", "topics/garden.md")
            )
          ),
          ownerMergeAgain: yield* write(repository, OWNER, (pages) =>
            updatePage(
              page(pages, "topics/seeds.md"),
              redirect("topics/seeds.md", "topics/garden.md")
            )
          ),
          ownerArchiveRoot: yield* write(repository, OWNER, (pages) =>
            archivePage(page(pages, "notes.md"))
          )
        }
      })
    )
    expect(outcome).toEqual({
      archiveRoot: "retire",
      mergeAgain: "retire",
      ownerMergeAgain: "saved",
      ownerArchiveRoot: "saved"
    })
  })
})

const refusal = <A>(effect: Effect.Effect<A, WikiError>) =>
  Effect.match(effect, {
    onFailure: (error): string => `${error.reason}: ${error.message}`,
    onSuccess: () => "saved"
  })

describe("the record folder checks of Memory's own writes", () => {
  const mutations = (repository: ManagedFileRepositoryShape) =>
    makeWikiMutationMethods(repository, spaces, makeWikiListingMethods(repository).read)

  it("homes no Space page in a record folder", async () => {
    const outcome = await withMemory(
      (repository) =>
        Effect.gen(function* () {
          const wiki = mutations(repository)
          return {
            projects: yield* refusal(
              wiki.createSpacePage({ home: "projects", spaceId: "space-1", title: "Kitchen" })
            ),
            areas: yield* refusal(
              wiki.createSpacePage({ home: "areas", spaceId: "space-2", title: "Garden" })
            )
          }
        }),
      [
        ["README.md", "Memory."],
        ["projects/README.md", CONTRACT, "auto-projects"],
        ["areas/README.md", CONTRACT]
      ]
    )
    expect(outcome).toEqual({
      projects: expect.stringMatching(
        /^blocked: The projects directory must be an active, unowned/u
      ),
      areas: "saved"
    })
  })

  it("opens no directory inside an Automation's record folder", async () => {
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        const wiki = mutations(repository)
        const directory = (path: string) =>
          refusal(
            wiki.createDirectory({
              path,
              body: CONTRACT,
              authority: GLOBAL_WIKI_LOCATION_AUTHORITY
            })
          )
        return {
          inRecords: yield* directory("daily/inner"),
          inTopics: yield* directory("topics/inner")
        }
      })
    )
    expect(outcome).toEqual({
      inRecords: "blocked: Report destinations cannot contain nested directories",
      inTopics: "saved"
    })
  })

  it("publishes a report only into its own Automation's folder", async () => {
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        const wiki = mutations(repository)
        const publish = (producerAutomationId: string, path: string) =>
          refusal(
            wiki.publishReport({
              path,
              title: "A day",
              body: "What happened.",
              period: { start: "2026-11-12T00:00:00Z", end: "2026-11-12T23:59:00Z" },
              sources: ["made-up source"],
              producerAutomationId,
              runId: "run-1",
              expectedVersion: undefined
            })
          )
        return {
          other: yield* publish("auto-other", "daily/2026-11-12.md"),
          knowledge: yield* publish("auto-daily", "topics/2026-11-12.md"),
          own: yield* publish("auto-daily", "daily/2026-11-12.md")
        }
      })
    )
    expect(outcome).toEqual({
      other: "blocked: This Automation does not own the report destination",
      knowledge: "blocked: This Automation does not own the report destination",
      own: "saved"
    })
  })

  it("refuses a rename into a record folder when it is asked for, before any approval", async () => {
    const outcome = await withMemory((repository) =>
      Effect.gen(function* () {
        const listing = makeWikiListingMethods(repository)
        const garden = yield* listing.read("id:topics/garden.md")
        const renames = makeWikiRenameMethods(
          repository,
          spaces,
          partialService<WikiRenameStore["Service"]>("WikiRenameStore", {})
        )
        return yield* refusal(
          renames.requestRename({
            pageId: "id:topics/garden.md",
            newPath: "daily/garden.md",
            newTitle: "Garden",
            expectedVersion: garden.version,
            expectedHead: yield* repository.currentRevision.pipe(Effect.map((head) => head ?? "")),
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY
          })
        )
      })
    )
    expect(outcome).toMatch(/^blocked: daily\/garden\.md /u)
  })
})
