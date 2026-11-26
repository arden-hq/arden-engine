import {
  CHANGE_ACTION,
  type Commit,
  type ManagedFileRepositoryShape,
  type ResourceChange
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"

import { decodeWikiOrigin, wikiOriginSource, type WikiCommitSource } from "./origin.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"
import { isCodeOwnedPage } from "./code-owned-pages.js"

const CHANGE_DIFF_CHARS = 12_000
const MIN_PAGE_CHARS = 400
const CHANGE_SEARCH_COMMITS = 2_000
const MAX_LISTED_SAVES = 20

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

interface WikiChangeCursor {
  readonly path: string
  readonly offset: number
}

export interface WikiChangeRead {
  readonly timestamp: string
  readonly actor: string
  readonly source: WikiCommitSource
  readonly reason: string
  readonly pages: ReadonlyArray<WikiChangedPage>
  readonly diffs: ReadonlyArray<WikiChangeDiff>
  readonly next: WikiChangeCursor | undefined
}

interface WikiChangeName {
  readonly path: string
  readonly pageId: string | undefined
  readonly at: string | undefined
}

interface WikiPageSpan {
  readonly pageId: string
  readonly path: string
  readonly base: string | null
  readonly head: string
  readonly offset: number
}

export interface WikiPageChangesRead {
  readonly path: string
  readonly isNew: boolean
  readonly saved: ReadonlyArray<{
    readonly timestamp: string
    readonly source: WikiCommitSource
    readonly reason: string
  }>
  readonly unlisted: number
  readonly diff: WikiChangeDiff
}

export interface WikiChangeMethods {
  readonly changeAt: (name: WikiChangeName) => Effect.Effect<Commit, WikiError>
  readonly readChange: (
    input: WikiChangeName & { readonly offset: number }
  ) => Effect.Effect<WikiChangeRead, WikiError>
  readonly readChangesSince: (span: WikiPageSpan) => Effect.Effect<WikiPageChangesRead, WikiError>
}

const touches =
  (name: WikiChangeName) =>
  (change: ResourceChange): boolean =>
    name.pageId === undefined
      ? change.before?.path === name.path || change.after?.path === name.path
      : (change.after ?? change.before)?.resourceId === name.pageId

export const shownPathToRuns = (path: string): boolean => !isCodeOwnedPage(path)

export const shownToRuns = (change: {
  readonly before: { readonly path: string } | null
  readonly after: { readonly path: string } | null
}): boolean =>
  [change.before?.path, change.after?.path].every(
    (path) => path === undefined || shownPathToRuns(path)
  )

const pathOf = (change: ResourceChange): string => (change.after ?? change.before)?.path ?? ""

const diffTarget = (change: ResourceChange) =>
  change.action === CHANGE_ACTION.archive ? null : change.after

const sameText = (change: ResourceChange): boolean =>
  change.before !== null &&
  diffTarget(change) !== null &&
  change.before.blobId === change.after?.blobId

export const makeWikiChangeMethods = (
  repository: ManagedFileRepositoryShape
): WikiChangeMethods => {
  const changeAt = Effect.fn("Wiki.changeAt")(function* (name: WikiChangeName) {
    const until = name.at === undefined ? undefined : Date.parse(name.at)
    if (until !== undefined && Number.isNaN(until))
      return yield* wikiError("history", "invalid", `${name.at ?? ""} is not a time.`)
    const commits = yield* repository
      .history({ resourceId: name.pageId ?? null, limit: CHANGE_SEARCH_COMMITS })
      .pipe(Effect.mapError(mapRevisionError("history", name.pageId)))
    const ofPage = commits.filter((commit) =>
      commit.changes.some((change) => shownToRuns(change) && touches(name)(change))
    )
    const found =
      ofPage.find((commit) => commit.timestamp === name.at) ??
      ofPage.find((commit) => until === undefined || Date.parse(commit.timestamp) <= until)
    if (found !== undefined) return found
    const oldest = ofPage.at(-1)
    return yield* wikiError(
      "history",
      "not_found",
      oldest === undefined
        ? `No saved Memory change to ${name.path} was found.`
        : `${name.path} had no saved change at or before ${name.at ?? ""}; its oldest change found was saved ${oldest.timestamp}.`
    )
  })

  const readChange = Effect.fn("Wiki.readChange")(function* (
    input: WikiChangeName & { readonly offset: number }
  ) {
    const commit = yield* changeAt(input)
    const changes = commit.changes.filter(shownToRuns)
    const start = changes.findIndex(touches(input))
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
  const readChangesSince = Effect.fn("Wiki.readChangesSince")(function* (span: WikiPageSpan) {
    const commits = yield* repository
      .history({
        resourceId: span.pageId,
        start: span.head,
        stopBefore: span.base,
        limit: CHANGE_SEARCH_COMMITS
      })
      .pipe(Effect.mapError(mapRevisionError("history", span.pageId)))
    const page = yield* repository
      .diffPage(span.base, span.head, span.pageId, {
        offset: span.offset,
        limit: CHANGE_DIFF_CHARS
      })
      .pipe(Effect.mapError(mapRevisionError("diff", span.pageId)))
    return {
      path: page.after?.path ?? span.path,
      isNew: page.before === null,
      saved: commits.slice(0, MAX_LISTED_SAVES).map((commit) => ({
        timestamp: commit.timestamp,
        source: wikiOriginSource(decodeWikiOrigin(commit.origin)),
        reason: commit.reason
      })),
      unlisted: Math.max(0, commits.length - MAX_LISTED_SAVES),
      diff: {
        path: page.after?.path ?? span.path,
        action: page.before === null ? "create" : "update",
        offset: page.offset,
        endOffset: page.endOffset,
        complete: !page.hasMore,
        text: page.unifiedDiff
      }
    }
  })
  return { changeAt, readChange, readChangesSince }
}
