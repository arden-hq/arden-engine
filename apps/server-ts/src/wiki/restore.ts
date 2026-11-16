import type { Commit, ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import type { WikiPage, WikiRestoreSide } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import { posix } from "node:path"

import type { WikiLocationAuthority } from "./authority.js"
import {
  decodeWikiOrigin,
  restoreArchivedPage,
  restoreVersion,
  type WikiCommitIdentity
} from "./commit.js"
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

/** The page as commit `commitId` left it (`after`), or as it was before that commit (`before`).
 *  `before` undoes an upkeep (Wiki Maintenance) commit, and only while it is the page's latest change. */
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
  /** The page text a restore would write, for the owner to review first. It is refused by every
   *  rule the restore itself would meet. */
  readonly contentToRestore: (input: WikiRestoreContentInput) => Effect.Effect<string, WikiError>
  readonly restoreArchived: (input: WikiRestoreArchivedInput) => Effect.Effect<WikiPage, WikiError>
}

/** The page text restoring `version` writes over `current`, judged against the page's history
 *  newest first, and whether that text is what the page holds already. */
export const contentRestoring = Effect.fn("Wiki.contentRestoring")(function* (
  repository: ManagedFileRepositoryShape,
  current: PageRecord,
  pageHistory: ReadonlyArray<Commit>,
  version: WikiRestoreVersion
) {
  const pageId = current.page.pageId
  const { commitId, side } = version
  const invalid = (message: string) => wikiError("restore", "invalid", message, { pageId })
  if (side === "before" && current.page.lifecycle !== "active") {
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
    if (side === "after") {
      if (change?.after?.state !== "active") {
        return yield* invalid(
          "Selected revision does not contain one active version of this Memory page"
        )
      }
      return change.after
    }
    if (decodeWikiOrigin(selected.origin).kind !== "upkeep") {
      return yield* invalid("Commit is not a Wiki Maintenance change")
    }
    if (change?.action !== "update" || change.before === null || change.after === null) {
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
  if (historical.page.lifecycle !== "active") {
    return yield* invalid("Selected revision is not an active Memory page")
  }
  const content = yield* replacementContent("restore", pageId, historical.page.content)
  return { content, unchanged: content === current.page.content }
})

export const makeWikiRestoreMethods = (
  repository: ManagedFileRepositoryShape,
  changes: WikiChanges
): WikiRestoreMethods => {
  /** The page as `input.version` holds it, written as its next version. */
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
          // A restore that changes nothing is still refused by the rules a change would meet.
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
          if (resource.state !== "archived") {
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
          if (archived.page.lifecycle !== "active") {
            return yield* wikiError(
              "restore",
              "invalid",
              "Archived page is not an active Memory page",
              { pageId: input.pageId }
            )
          }
          const own = posix.dirname(resource.path)
          const directory = isReadme(resource.path) ? posix.dirname(own) : own
          if (directory !== "." && directoryReadme(snapshot.wholeSet, directory) === undefined) {
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
