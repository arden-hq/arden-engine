import { writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type Commit,
  type ManagedFileRepositoryShape,
  type ResourceChange,
  type RevisionError
} from "@arden-hq/revisions/effect"
import { Effect, Option } from "effect"
import { expect, it } from "vitest"

import {
  archivePage,
  createPage,
  decodeWikiOrigin,
  movePage,
  publishReport,
  requireCommitRules,
  restoreArchivedPage,
  updatePage,
  type WikiWrite
} from "../src/wiki/commit.js"
import { parseWikiPage } from "../src/wiki/page.js"
import { locateReplayCopy } from "./fixtures/replay-copy.js"
import { withoutSpaces } from "./fixtures/wiki-repository.js"

const located = locateReplayCopy()
const decoder = new TextDecoder()

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

const updateAction = (
  commit: Commit,
  text: string
): "edit" | "publish" | "restore_version" | "merge" => {
  const page = Effect.runSync(Effect.option(parseWikiPage(text)))
  if (Option.isSome(page) && page.value.lifecycle === "redirect") return "merge"
  if (/^publish report /iu.test(commit.reason)) return "publish"
  if (/^restore /iu.test(commit.reason)) return "restore_version"
  return "edit"
}

const writeOf = Effect.fn("writeOf")(function* (
  repository: ManagedFileRepositoryShape,
  commit: Commit,
  change: ResourceChange
): Effect.fn.Return<WikiWrite | undefined, RevisionError> {
  const content = change.after === null ? undefined : yield* repository.readVersion(change.after)
  const text = content === undefined ? "" : decoder.decode(content)
  switch (change.action) {
    case "create":
      if (change.after === null) return undefined
      return /^publish report /iu.test(commit.reason)
        ? publishReport({ resourceId: change.after.resourceId, path: change.after.path }, text)
        : createPage(change.after.resourceId, change.after.path, text)
    case "update": {
      if (change.before === null) return undefined
      const edit = updatePage(change.before, text)
      return edit.action === "edit"
        ? { action: updateAction(commit, text), operation: edit.operation }
        : undefined
    }
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
      return change.before === null ? undefined : restoreArchivedPage(change.before)
    default:
      return undefined
  }
})

const outcomeOf = Effect.fn("outcomeOf")(function* (
  repository: ManagedFileRepositoryShape,
  commit: Commit
) {
  const writes: Array<WikiWrite> = []
  for (const change of commit.changes) {
    const write = yield* writeOf(repository, commit, change)
    if (write === undefined) return { outcome: "unreadable", actions: [] }
    writes.push(write)
  }
  const origin = decodeWikiOrigin(commit.origin)
  const outcome = yield* requireCommitRules(
    withoutSpaces(pinnedAt(repository, commit.parentId)),
    origin,
    writes
  ).pipe(
    Effect.match({
      onSuccess: () => "allowed",
      onFailure: (error) =>
        error._tag === "WikiCommitRuleError" ? `refused:${error.rule}` : `failed:${error._tag}`
    })
  )
  return { outcome, actions: writes.map((write) => `${origin.kind} ${write.action}`) }
})

it("replays every past Memory commit through today's commit rules and counts each outcome", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const wiki = located.copy.wiki
  const { byCommit: outcomes, actions } = await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const commits = [...(yield* repository.history({ limit: null }))].reverse()
      const byCommit: Array<readonly [string, string]> = []
      const actions: Record<string, number> = {}
      for (const commit of commits) {
        const replayed = yield* outcomeOf(repository, commit)
        byCommit.push([commit.commitId, replayed.outcome])
        for (const action of replayed.actions) actions[action] = (actions[action] ?? 0) + 1
      }
      return { byCommit, actions }
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
  process.stdout.write(
    `\nPast Memory commits by outcome:\n${JSON.stringify(counts, null, 2)}\n` +
      `Their writes by writer and action:\n${JSON.stringify(actions, null, 2)}\n`
  )
  expect(outcomes.length).toBeGreaterThan(0)
  expect(outcomes.filter(([, outcome]) => !/^(allowed|refused:)/u.test(outcome))).toEqual([])
}, 1_200_000)
