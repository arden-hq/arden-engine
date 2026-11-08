import type { ManagedFileRepositoryShape, ResourceChange } from "@arden-hq/revisions/effect"
import { Effect } from "effect"

import { decodeWikiOrigin, wikiOriginSource, type WikiCommitSource } from "./commit.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"

const CHANGE_DIFF_CHARS = 12_000
const MIN_PAGE_CHARS = 400

interface WikiChangedPage {
  readonly action: string
  readonly path: string
  readonly beforePath: string | null
  readonly afterPath: string | null
}

interface WikiChangeDiff {
  readonly path: string
  readonly action: string
  readonly offset: number
  readonly endOffset: number
  readonly complete: boolean
  readonly text: string
}

export interface WikiChangeCursor {
  readonly path: string
  readonly offset: number
}

export interface WikiChangeRead {
  readonly revision: string
  readonly timestamp: string
  readonly actor: string
  readonly source: WikiCommitSource
  readonly reason: string
  readonly pages: ReadonlyArray<WikiChangedPage>
  readonly diffs: ReadonlyArray<WikiChangeDiff>
  readonly next: WikiChangeCursor | undefined
}

export interface WikiChangeMethods {
  readonly readChange: (input: {
    readonly revision: string
    readonly path: string | undefined
    readonly offset: number
  }) => Effect.Effect<WikiChangeRead, WikiError>
}

const pathOf = (change: ResourceChange): string => (change.after ?? change.before)?.path ?? ""

const diffTarget = (change: ResourceChange) => (change.action === "archive" ? null : change.after)

const sameText = (change: ResourceChange): boolean =>
  change.before !== null &&
  diffTarget(change) !== null &&
  change.before.blobId === change.after?.blobId

export const makeWikiChangeMethods = (
  repository: ManagedFileRepositoryShape
): WikiChangeMethods => {
  const readChange = Effect.fn("Wiki.readChange")(function* (input: {
    readonly revision: string
    readonly path: string | undefined
    readonly offset: number
  }) {
    const commit = yield* repository
      .inspectCommit(input.revision)
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "RevisionConflictError"
            ? wikiError(
                "history",
                "not_found",
                `No saved Memory change has revision ${input.revision}.`
              )
            : mapRevisionError("history")(cause)
        )
      )
    const changes = commit.changes
    const start =
      input.path === undefined
        ? 0
        : changes.findIndex(
            (change) =>
              pathOf(change) === input.path ||
              change.before?.path === input.path ||
              change.after?.path === input.path
          )
    if (start < 0)
      return yield* wikiError(
        "history",
        "invalid",
        `Revision ${input.revision} did not change ${input.path ?? ""}.`
      )
    const diffs: Array<WikiChangeDiff> = []
    let budget = CHANGE_DIFF_CHARS
    let next: WikiChangeCursor | undefined
    for (const [index, change] of changes.entries()) {
      if (index < start) continue
      const offset = index === start ? input.offset : 0
      if (index > start && budget < MIN_PAGE_CHARS) {
        next = { path: pathOf(change), offset: 0 }
        break
      }
      if (sameText(change)) {
        diffs.push({
          path: pathOf(change),
          action: change.action,
          offset: 0,
          endOffset: 0,
          complete: true,
          text: ""
        })
        continue
      }
      const page = yield* repository
        .diffVersionsPage(change.before, diffTarget(change), { offset, limit: budget })
        .pipe(
          Effect.mapError(mapRevisionError("diff", (change.after ?? change.before)?.resourceId))
        )
      diffs.push({
        path: pathOf(change),
        action: change.action,
        offset: page.offset,
        endOffset: page.endOffset,
        complete: !page.hasMore,
        text: page.unifiedDiff
      })
      if (page.hasMore) {
        next = { path: pathOf(change), offset: page.endOffset }
        break
      }
      budget -= page.endOffset - page.offset
    }
    return {
      revision: commit.commitId,
      timestamp: commit.timestamp,
      actor: commit.actor,
      source: wikiOriginSource(decodeWikiOrigin(commit.origin)),
      reason: commit.reason,
      pages: changes.map((change) => ({
        action: change.action,
        path: pathOf(change),
        beforePath: change.before?.path ?? null,
        afterPath: change.after?.path ?? null
      })),
      diffs,
      next
    }
  })
  return { readChange }
}
