import { WORKING_FILE_CHANGE_KIND } from "@arden-hq/revisions/effect"
import type { AdoptableWorkingChange, CommitResult } from "@arden-hq/revisions/effect"
import { Effect } from "effect"

import { formatRedirectPage } from "./page.js"
import { encodeWikiOrigin, type WikiCommitIdentity } from "./origin.js"
import {
  type WikiWriter,
  type WikiWrite,
  type PageVersion,
  encoder,
  created,
  updated,
  type WikiCommitError,
  type WikiCommitPoint
} from "./commit-write-types.js"
import { requireCommitRules } from "./commit-rules.js"

export const createPage = (resourceId: string, path: string, content: string): WikiWrite => ({
  action: "create",
  operation: created(resourceId, path, content)
})

export const newPage = (resourceId: string, path: string, content: string): WikiWrite => ({
  action: "new_page",
  operation: created(resourceId, path, content)
})

export const updatePage = (page: PageVersion, content: string): WikiWrite => ({
  action: "edit",
  operation: updated(page, content)
})

export const publishReport = (
  page: PageVersion | { readonly resourceId: string; readonly path: string },
  content: string
): WikiWrite => ({
  action: "publish",
  operation:
    "versionId" in page ? updated(page, content) : created(page.resourceId, page.path, content)
})

export const restoreVersion = (page: PageVersion, content: string): WikiWrite => ({
  action: "restore_version",
  operation: updated(page, content)
})

export const mergePage = (
  page: PageVersion,
  redirect: { readonly pageId: string; readonly title: string; readonly redirectTo: string }
): WikiWrite => ({
  action: "merge",
  operation: updated(page, formatRedirectPage(redirect))
})

export const movePage = (page: PageVersion, path: string, content?: string): WikiWrite => ({
  action: "move",
  operation: {
    _tag: "Move",
    resourceId: page.resourceId,
    expectedVersion: page.versionId,
    path,
    ...(content === undefined ? {} : { content: encoder.encode(content) })
  }
})

export const archivePage = (page: PageVersion): WikiWrite => ({
  action: "archive",
  operation: { _tag: "Archive", resourceId: page.resourceId, expectedVersion: page.versionId }
})

export const restoreArchivedPage = (page: PageVersion): WikiWrite => ({
  action: "restore_archived",
  operation: { _tag: "Restore", resourceId: page.resourceId, expectedVersion: page.versionId }
})

export const commitWiki = (
  point: WikiCommitPoint,
  options: WikiCommitIdentity & WikiWriter & { readonly expectedRevision: string | null },
  writes: ReadonlyArray<WikiWrite>
): Effect.Effect<CommitResult, WikiCommitError> => {
  const { replayKey } = options
  return requireCommitRules(point, options, writes).pipe(
    Effect.andThen(
      point.repository.commit({
        actor: options.actor,
        origin: encodeWikiOrigin(options.origin),
        reason: options.reason,
        operations: writes.map((write) => write.operation),
        ...(options.expectedRevision === null
          ? { expectedHead: null, enforceExpectedHead: true }
          : { expectedHead: options.expectedRevision }),
        ...(replayKey === undefined ? {} : { idempotencyKey: replayKey })
      })
    )
  )
}

export const commitOutsideChange = (
  point: WikiCommitPoint,
  options: WikiCommitIdentity & WikiWriter & { readonly expectedRevision: string | null },
  change: AdoptableWorkingChange
): Effect.Effect<CommitResult, WikiCommitError> =>
  requireCommitRules(point, options, [
    change.kind === WORKING_FILE_CHANGE_KIND.changed
      ? {
          action: "edit",
          operation: {
            _tag: "Update",
            resourceId: change.resource.resourceId,
            expectedVersion: change.resource.versionId,
            content: change.content
          }
        }
      : archivePage(change.resource)
  ]).pipe(
    Effect.andThen(
      point.repository.adoptWorkingChange(change, {
        actor: options.actor,
        origin: encodeWikiOrigin(options.origin),
        reason: options.reason,
        expectedHead: options.expectedRevision
      })
    )
  )
