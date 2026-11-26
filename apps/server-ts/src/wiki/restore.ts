import {
  PATH_SEGMENT,
  type Commit,
  type ManagedFileRepositoryShape,
  RESOURCE_STATE,
  CHANGE_ACTION
} from "@arden-hq/revisions/effect"
import {
  WIKI_RESTORE_SIDE,
  WIKI_PAGE_LIFECYCLE,
  type WikiPage,
  type WikiRestoreSide
} from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import { posix } from "node:path"

import type { WikiLocationAuthority } from "./authority.js"
import { restoreArchivedPage, restoreVersion } from "./commit.js"
import { WIKI_ORIGIN_KIND, decodeWikiOrigin, type WikiCommitIdentity } from "./origin.js"
import { mapRevisionError, type WikiError, wikiError } from "./errors.js"
import { pageIn, writerOf, type WikiChanges } from "./page-change.js"
import { isReadme, replacementContent } from "./page.js"
import {
  directoryReadme,
  nameTakenBy,
  notFound,
  type PageRecord,
  readRecord,
  type Snapshot
} from "./snapshot.js"

interface WikiRestoreVersion {
  readonly commitId: string
  readonly side: WikiRestoreSide
}

interface WikiRestoreInput {
  readonly pageId: string
  readonly version: WikiRestoreVersion
  readonly expectedVersion: string
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
  readonly commit: WikiCommitIdentity
}

interface WikiRestoreContentInput {
  readonly pageId: string
  readonly version: WikiRestoreVersion
  readonly head: string
  readonly authority: WikiLocationAuthority
  readonly commit: WikiCommitIdentity
}

interface WikiRestoreArchivedInput {
  readonly pageId: string
  readonly expectedVersion: string
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
  readonly commit: WikiCommitIdentity
}

export interface WikiRestoreMethods {
  readonly restore: (input: WikiRestoreInput) => Effect.Effect<WikiPage, WikiError>
  readonly contentToRestore: (input: WikiRestoreContentInput) => Effect.Effect<string, WikiError>
  readonly restoreArchived: (input: WikiRestoreArchivedInput) => Effect.Effect<WikiPage, WikiError>
}

export const contentRestoring = Effect.fn("Wiki.contentRestoring")(function* (
  repository: ManagedFileRepositoryShape,
  current: PageRecord,
  pageHistory: ReadonlyArray<Commit>,
  version: WikiRestoreVersion
) {
  const pageId = current.page.pageId
  const { commitId, side } = version
  const invalid = (message: string) => wikiError("restore", "invalid", message, { pageId })
  if (side === WIKI_RESTORE_SIDE.before && current.page.lifecycle !== WIKI_PAGE_LIFECYCLE.active) {
    return yield* invalid("Only active Memory pages can be restored")
  }
  const selected = pageHistory.find((commit) => commit.commitId === commitId)
  if (selected === undefined) {
    return yield* wikiError(
      "restore",
      "not_found",
      `Revision is not a reachable page change: ${commitId}`,
      { pageId }
    )
  }
  const changes = selected.changes.filter(
    (change) => (change.after ?? change.before)?.resourceId === pageId
  )
  const change = changes.length === 1 ? changes[0] : undefined
  const resource = yield* Effect.gen(function* () {
    if (side === WIKI_RESTORE_SIDE.after) {
      if (change?.after?.state !== RESOURCE_STATE.active) {
        return yield* invalid(
          "Selected revision does not contain one active version of this Memory page"
        )
      }
      return change.after
    }
    if (decodeWikiOrigin(selected.origin).kind !== WIKI_ORIGIN_KIND.upkeep) {
      return yield* invalid("Commit is not a Wiki Maintenance change")
    }
    if (
      change?.action !== CHANGE_ACTION.update ||
      change.before === null ||
      change.after === null
    ) {
      return yield* invalid("Maintenance commit must contain exactly one page update")
    }
    if (
      pageHistory[0]?.commitId !== commitId ||
      current.resource.versionId !== change.after.versionId
    ) {
      return yield* wikiError(
        "restore",
        "conflict",
        `Memory page changed after Maintenance commit ${commitId}`,
        { pageId }
      )
    }
    return change.before
  })
  const historical = yield* readRecord(repository, "restore", resource, "invalid")
  if (historical.page.lifecycle !== WIKI_PAGE_LIFECYCLE.active) {
    return yield* invalid("Selected revision is not an active Memory page")
  }
  const content = yield* replacementContent("restore", pageId, historical.page.content)
  return { content, unchanged: content === current.page.content }
})

export const makeWikiRestoreMethods = (
  repository: ManagedFileRepositoryShape,
  changes: WikiChanges
): WikiRestoreMethods => {
  const restorePlan = (input: Pick<WikiRestoreContentInput, "pageId" | "version" | "head">) =>
    Effect.fn("Wiki.planRestore")(function* (snapshot: Snapshot) {
      const current = yield* pageIn("restore", snapshot, input.pageId)
      const pageHistory = yield* repository
        .history({ resourceId: input.pageId, start: input.head, limit: null })
        .pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
      const value = yield* contentRestoring(repository, current, pageHistory, input.version)
      return { writes: [restoreVersion(current.resource, value.content)], value }
    })

  const contentToRestore = (input: WikiRestoreContentInput) =>
    changes
      .preview(writerOf("restore", input), restorePlan(input))
      .pipe(Effect.map(({ content }) => content))

  const restore = (input: WikiRestoreInput) => {
    const writer = writerOf("restore", input, input.expectedHead, [input])
    return changes
      .change(writer, (snapshot) =>
        restorePlan({ ...input, head: input.expectedHead })(snapshot).pipe(
          Effect.tap((plan) =>
            plan.value.unchanged ? changes.check(writer, plan.writes) : Effect.void
          ),
          Effect.map((plan) => (plan.value.unchanged ? { ...plan, writes: [] } : plan))
        )
      )
      .pipe(Effect.andThen(changes.saved("restore", input.pageId)))
  }

  const restoreArchived = (input: WikiRestoreArchivedInput) =>
    changes
      .change(
        writerOf("restore", input),
        Effect.fn("Wiki.planRestoreArchived")(function* (snapshot) {
          const resource = yield* repository
            .get(input.pageId, { at: snapshot.head })
            .pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
          if (resource === null) return yield* notFound("restore", input.pageId)
          if (resource.state !== RESOURCE_STATE.archived) {
            return yield* wikiError(
              "restore",
              "invalid",
              "Only archived Memory pages can be restored",
              { pageId: input.pageId }
            )
          }
          if (
            snapshot.head !== input.expectedHead ||
            resource.versionId !== input.expectedVersion
          ) {
            return yield* wikiError("restore", "conflict", "Memory page changed", {
              pageId: input.pageId
            })
          }
          const archived = yield* readRecord(repository, "restore", resource)
          if (archived.page.lifecycle !== WIKI_PAGE_LIFECYCLE.active) {
            return yield* wikiError(
              "restore",
              "invalid",
              "Archived page is not an active Memory page",
              { pageId: input.pageId }
            )
          }
          const own = posix.dirname(resource.path)
          const directory = isReadme(resource.path) ? posix.dirname(own) : own
          if (
            directory !== PATH_SEGMENT.current &&
            directoryReadme(snapshot.wholeSet, directory) === undefined
          ) {
            return yield* wikiError(
              "restore",
              "blocked",
              `Restore the Memory folder ${directory} first`,
              { pageId: input.pageId }
            )
          }
          const taken = nameTakenBy(snapshot, resource.path)
          if (taken !== undefined) {
            return yield* wikiError(
              "restore",
              "conflict",
              `Memory path or link name is taken by ${taken.resource.path}`,
              { pageId: input.pageId }
            )
          }
          return { writes: [restoreArchivedPage(resource)], value: undefined }
        })
      )
      .pipe(Effect.andThen(changes.saved("restore", input.pageId)))

  return { restore, contentToRestore, restoreArchived }
}
