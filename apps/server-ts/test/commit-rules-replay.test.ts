import { writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type Commit,
  type ManagedFileRepositoryShape,
  type ResourceChange
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { expect, it } from "vitest"

import {
  archivePage,
  createPage,
  decodeWikiOrigin,
  movePage,
  requireCommitRules,
  restorePage,
  updatePage,
  type WikiPageOperation
} from "../src/wiki/commit.js"
import { locateReplayCopy } from "./fixtures/replay-copy.js"

const located = locateReplayCopy()
const decoder = new TextDecoder()

/** The repository as it stood just before `parent`'s child commit: every read is pinned there. */
const pinnedAt = (
  repository: ManagedFileRepositoryShape,
  parent: string | null
): ManagedFileRepositoryShape =>
  parent === null
    ? {
        ...repository,
        get: () => Effect.succeed(null),
        findByPath: () => Effect.succeed(null),
        listResources: () => Effect.succeed([]),
        history: () => Effect.succeed([])
      }
    : {
        ...repository,
        get: (resourceId, options) => repository.get(resourceId, { ...options, at: parent }),
        findByPath: (path, options) => repository.findByPath(path, { ...options, at: parent }),
        listResources: (options) => repository.listResources({ ...options, at: parent }),
        history: (options) => repository.history({ ...options, start: parent })
      }

const operationOf = Effect.fn("operationOf")(function* (
  repository: ManagedFileRepositoryShape,
  change: ResourceChange
) {
  const content = change.after === null ? undefined : yield* repository.readVersion(change.after)
  const text = content === undefined ? "" : decoder.decode(content)
  switch (change.action) {
    case "create":
      return change.after === null
        ? undefined
        : createPage(change.after.resourceId, change.after.path, text)
    case "update":
      return change.before === null ? undefined : updatePage(change.before, text)
    case "move":
      return change.before === null || change.after === null
        ? undefined
        : movePage(
            change.before,
            change.after.path,
            change.after.blobId === change.before.blobId ? undefined : text
          )
    case "archive":
      return change.before === null ? undefined : archivePage(change.before)
    case "restore":
      return change.before === null ? undefined : restorePage(change.before)
    default:
      return undefined
  }
})

const outcomeOf = Effect.fn("outcomeOf")(function* (
  repository: ManagedFileRepositoryShape,
  commit: Commit
) {
  const operations: Array<WikiPageOperation> = []
  for (const change of commit.changes) {
    const operation = yield* operationOf(repository, change)
    if (operation === undefined) return "unreadable"
    operations.push(operation)
  }
  return yield* requireCommitRules(
    pinnedAt(repository, commit.parentId),
    decodeWikiOrigin(commit.origin),
    operations
  ).pipe(
    Effect.match({
      onSuccess: () => "allowed",
      onFailure: (error) =>
        error._tag === "WikiCommitRuleError" ? `refused:${error.rule}` : `failed:${error._tag}`
    })
  )
})

it("replays every past Memory commit through today's commit rules and counts each outcome", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const wiki = located.copy.wiki
  const outcomes = await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const commits = [...(yield* repository.history({ limit: null }))].reverse()
      const byCommit: Array<readonly [string, string]> = []
      for (const commit of commits)
        byCommit.push([commit.commitId, yield* outcomeOf(repository, commit)])
      return byCommit
    }).pipe(
      Effect.scoped,
      Effect.provide(
        managedFileRepositoryNodeLayer({
          workingRoot: join(wiki, "pages"),
          historyRoot: join(wiki, ".wiki-history")
        })
      )
    )
  )
  const counts: Record<string, number> = {}
  for (const [, outcome] of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1
  const out = process.env["ARDEN_COMMIT_REPLAY_OUT"]
  if (out !== undefined && out !== "") writeFileSync(out, JSON.stringify(outcomes))
  process.stdout.write(`\nPast Memory commits by outcome:\n${JSON.stringify(counts, null, 2)}\n`)
  expect(outcomes.length).toBeGreaterThan(0)
  expect(outcomes.filter(([, outcome]) => !/^(allowed|refused:)/u.test(outcome))).toEqual([])
}, 1_200_000)
