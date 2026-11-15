import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryShape
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { makeWikiCaptureMethods } from "../src/wiki/capture.js"
import {
  createPage,
  updatePage,
  type WikiCommitIdentity,
  type WikiPageOperation
} from "../src/wiki/commit.js"
import type { WikiError } from "../src/wiki/errors.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { makeWikiRestoreMethods } from "../src/wiki/restore.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { partialService } from "./kit.js"

const OWNER: WikiCommitIdentity = {
  actor: "user:desktop",
  origin: { kind: "user", via: "desktop" },
  reason: "owner restore"
}

const readme = (retention: string) =>
  formatWikiPage({
    pageId: "reports",
    title: "Reports",
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: { producer_automation_id: "auto-reports" },
    body: `## Purpose\n\nReports.\n\n## Retention\n\n${retention}\n`
  })

const profile = (body: string) =>
  formatWikiPage({
    pageId: "me",
    title: "Me",
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body
  })

const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {
  activeBindings: () => Effect.succeed([])
})

const unchecked = (repository: ManagedFileRepositoryShape, operation: WikiPageOperation) =>
  Effect.gen(function* () {
    const head = yield* repository.currentRevision
    return yield* repository.commit({
      actor: "test",
      origin: "test.unchecked",
      reason: "write past the rules",
      operations: [operation],
      expectedHead: head
    })
  })

const message = <A>(effect: Effect.Effect<A, WikiError>) =>
  Effect.match(effect, { onFailure: (error) => error.message, onSuccess: () => "saved" })

it("refuses an unreadable retention rule from Capture, a restore and its approval card", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-page-rules-"))
  try {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        const listing = makeWikiListingMethods(repository)
        const capture = makeWikiCaptureMethods(repository, spaces, listing.read)
        const restores = makeWikiRestoreMethods(repository, spaces, listing.read)
        yield* unchecked(
          repository,
          createPage("reports", "reports/README.md", readme("Keep: 1 month"))
        )
        const bad = yield* repository.get("reports")
        if (bad === null) throw new Error("reports/README.md is missing")
        const badCommit = (yield* repository.currentRevision) ?? ""
        yield* unchecked(repository, updatePage(bad, readme("Keep: 30 days")))
        const good = yield* repository.get("reports")
        if (good === null) throw new Error("reports/README.md is missing")
        const head = (yield* repository.currentRevision) ?? ""
        const restoreInput = {
          pageId: "reports",
          commitId: badCommit,
          authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
          commit: OWNER
        }
        return {
          capture: yield* message(
            capture.applyCapturePatchSet({
              edits: [
                { pageId: "reports", content: readme("Keep: 30d"), expectedVersion: good.versionId }
              ],
              expectedHead: head,
              authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
              batch: {
                sessionId: "chat-1",
                start: { _tag: "Beginning" },
                end: { _tag: "AfterSequence", sequence: 3 },
                endMessageId: "message-3"
              },
              commit: { actor: "memory:capture", reason: "capture" }
            })
          ),
          card: yield* message(restores.contentToRestore({ ...restoreInput, head })),
          restore: yield* message(
            restores.restoreRevision({
              ...restoreInput,
              expectedVersion: good.versionId,
              expectedHead: head
            })
          )
        }
      }).pipe(Effect.scoped, Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })))
    )
    expect(outcome).toEqual({
      capture: expect.stringMatching(/^The retention rule "Keep: 30d" was not understood/u),
      card: expect.stringMatching(/^The retention rule "Keep: 1 month" was not understood/u),
      restore: expect.stringMatching(/^The retention rule "Keep: 1 month" was not understood/u)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("refuses a restore over the size limit on its approval card, before the owner approves", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-page-rules-"))
  try {
    const card = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        const listing = makeWikiListingMethods(repository)
        const restores = makeWikiRestoreMethods(repository, spaces, listing.read)
        yield* unchecked(repository, createPage("me", "me.md", profile("a".repeat(9_068))))
        const over = (yield* repository.currentRevision) ?? ""
        const page = yield* repository.get("me")
        if (page === null) throw new Error("me.md is missing")
        yield* unchecked(repository, updatePage(page, profile("Short.")))
        return yield* message(
          restores.contentToRestore({
            pageId: "me",
            commitId: over,
            head: (yield* repository.currentRevision) ?? "",
            authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
            commit: OWNER
          })
        )
      }).pipe(Effect.scoped, Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root })))
    )
    expect(card).toMatch(/^me\.md would have 9068 characters; its limit is 9000/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const SOURCE = join(import.meta.dirname, "../src/wiki")
const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

const REPLACEMENT_RULES = [
  { check: /\bwrittenContent\(/u, owner: "write-rules.ts", defined: "page.ts" },
  { check: /\bunreadableKeepRule\(/u, owner: "write-rules.ts", defined: "report-retention.ts" },
  { check: /\baliasesAreHuman\(/u, owner: "commit.ts", defined: "page.ts" },
  { check: /\bcorePageBudget\(/u, owner: "commit.ts", defined: undefined }
]

it("decides what text may replace a page only in write-rules.ts and the commit point", () => {
  const found = REPLACEMENT_RULES.map(({ check, owner, defined }) => ({
    owner,
    files: sources(SOURCE)
      .map((path) => relative(SOURCE, path))
      .filter((path) => path !== defined && check.test(readFileSync(join(SOURCE, path), "utf8")))
  }))
  expect(found).toEqual(REPLACEMENT_RULES.map(({ owner }) => ({ owner, files: [owner] })))
})
