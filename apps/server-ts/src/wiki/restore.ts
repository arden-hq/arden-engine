import type { ManagedFileRepositoryShape, ResourceVersion } from "@arden-hq/revisions/effect"
import type { WikiPage } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import { posix } from "node:path"

import type { SpaceStore } from "../persistence/spaces/store.js"
import type { WikiLocationAuthority } from "./authority.js"
import {
  commitWiki,
  decodeWikiOrigin,
  requireCommitRules,
  restoreArchivedPage,
  restoreVersion,
  type WikiCommitIdentity
} from "./commit.js"
import { requireCurrent, withConflictDetail } from "./conflict.js"
import { mapRevisionError, WikiError, wikiError } from "./errors.js"
import type { WikiListingMethods } from "./listing.js"
import { isReadme, replacementContent } from "./page.js"
import {
  directoryReadme,
  loadSnapshot,
  nameTakenBy,
  notFound,
  type PageRecord,
  readRecord
} from "./snapshot.js"

/** The page as commit `commitId` left it (`after`), or as it was before that commit (`before`).
 *  `before` undoes an upkeep (Wiki Maintenance) commit, and only while it is the page's latest change. */
interface WikiRestoreVersion {
  readonly commitId: string
  readonly side: "after" | "before"
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

export const makeWikiRestoreMethods = (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  read: WikiListingMethods["read"]
): WikiRestoreMethods => {
  const versionToRestore = Effect.fn("Wiki.versionToRestore")(function* (
    current: PageRecord,
    input: Pick<WikiRestoreContentInput, "pageId" | "version" | "head">
  ) {
    const { commitId, side } = input.version
    if (side === "before" && current.page.lifecycle !== "active") {
      return yield* wikiError("restore", "invalid", "Only active Wiki pages can be restored", {
        pageId: input.pageId
      })
    }
    const pageHistory = yield* repository
      .history({ resourceId: input.pageId, start: input.head, limit: null })
      .pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
    const selected = pageHistory.find((commit) => commit.commitId === commitId)
    if (selected === undefined) {
      return yield* wikiError(
        "restore",
        "not_found",
        `Revision is not a reachable page change: ${commitId}`,
        { pageId: input.pageId }
      )
    }
    const changes = selected.changes.filter(
      (change) => (change.after ?? change.before)?.resourceId === input.pageId
    )
    const change = changes.length === 1 ? changes[0] : undefined
    const invalid = (message: string) =>
      wikiError("restore", "invalid", message, { pageId: input.pageId })
    if (side === "after") {
      if (change?.after?.state !== "active") {
        return yield* invalid(
          "Selected revision does not contain one active version of this Wiki page"
        )
      }
      return yield* activeVersion(change.after, invalid)
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
        `Wiki page changed after Maintenance commit ${commitId}`,
        { pageId: input.pageId }
      )
    }
    return yield* activeVersion(change.before, invalid)
  })

  const activeVersion = Effect.fn("Wiki.activeVersion")(function* (
    resource: ResourceVersion,
    invalid: (message: string) => WikiError
  ) {
    const historical = yield* readRecord(repository, "restore", resource, "invalid")
    if (historical.page.lifecycle !== "active") {
      return yield* invalid("Selected revision is not an active Wiki page")
    }
    return historical
  })

  const restorableContent = Effect.fn("Wiki.restorableContent")(function* (
    current: PageRecord,
    input: WikiRestoreContentInput
  ) {
    const historical = yield* versionToRestore(current, input)
    const content = yield* replacementContent("restore", input.pageId, historical.page.content)
    yield* requireCommitRules(
      { repository, spaces },
      { origin: input.commit.origin, authority: input.authority },
      [restoreVersion(current.resource, content)]
    ).pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
    return content
  })

  const contentToRestore = Effect.fn("Wiki.contentToRestore")(function* (
    input: WikiRestoreContentInput
  ) {
    const snapshot = yield* loadSnapshot(repository, "restore")
    const current = snapshot.wholeSet.find((record) => record.page.pageId === input.pageId)
    if (current === undefined) return yield* notFound("restore", input.pageId)
    return yield* restorableContent(current, input)
  })

  const restore = Effect.fn("Wiki.restore")(function* (input: WikiRestoreInput) {
    return yield* withConflictDetail(
      repository,
      Effect.gen(function* () {
        const snapshot = yield* loadSnapshot(repository, "restore")
        const current = yield* requireCurrent(
          "restore",
          snapshot,
          input.pageId,
          input.expectedVersion,
          input.expectedHead
        )
        const content = yield* restorableContent(current, { ...input, head: input.expectedHead })
        if (content === current.page.content) {
          const latestHead = yield* repository.currentRevision.pipe(
            Effect.mapError(mapRevisionError("restore", input.pageId))
          )
          if (latestHead !== input.expectedHead) {
            return yield* wikiError("restore", "conflict", "Wiki changed during the restore", {
              pageId: input.pageId
            })
          }
        } else {
          yield* commitWiki(
            { repository, spaces },
            { ...input.commit, authority: input.authority, expectedRevision: input.expectedHead },
            [restoreVersion(current.resource, content)]
          ).pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
        }
        return yield* read(input.pageId).pipe(
          Effect.mapError((cause) => new WikiError({ ...cause, operation: "restore" }))
        )
      })
    )
  })

  const restoreArchived = Effect.fn("Wiki.restoreArchived")(function* (
    input: WikiRestoreArchivedInput
  ) {
    return yield* withConflictDetail(
      repository,
      Effect.gen(function* () {
        const snapshot = yield* loadSnapshot(repository, "restore")
        const resource = yield* repository
          .get(input.pageId, { at: snapshot.head })
          .pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
        if (resource === null) return yield* notFound("restore", input.pageId)
        if (resource.state !== "archived") {
          return yield* wikiError(
            "restore",
            "invalid",
            "Only archived Wiki pages can be restored",
            {
              pageId: input.pageId
            }
          )
        }
        if (snapshot.head !== input.expectedHead || resource.versionId !== input.expectedVersion) {
          return yield* wikiError("restore", "conflict", "Wiki page changed", {
            pageId: input.pageId
          })
        }
        const archived = yield* readRecord(repository, "restore", resource)
        if (archived.page.lifecycle !== "active") {
          return yield* wikiError(
            "restore",
            "invalid",
            "Archived page is not an active Wiki page",
            {
              pageId: input.pageId
            }
          )
        }
        const own = posix.dirname(resource.path)
        const directory = isReadme(resource.path) ? posix.dirname(own) : own
        if (directory !== "." && directoryReadme(snapshot.wholeSet, directory) === undefined) {
          return yield* wikiError(
            "restore",
            "blocked",
            `Restore the Wiki directory ${directory} first`,
            { pageId: input.pageId }
          )
        }
        const taken = nameTakenBy(snapshot, resource.path)
        if (taken !== undefined) {
          return yield* wikiError(
            "restore",
            "conflict",
            `Wiki path or link name is taken by ${taken.resource.path}`,
            { pageId: input.pageId }
          )
        }
        yield* commitWiki(
          { repository, spaces },
          { ...input.commit, authority: input.authority, expectedRevision: input.expectedHead },
          [restoreArchivedPage(resource)]
        ).pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
        return yield* read(input.pageId).pipe(
          Effect.mapError((cause) => new WikiError({ ...cause, operation: "restore" }))
        )
      })
    )
  })

  return { restore, contentToRestore, restoreArchived }
}
