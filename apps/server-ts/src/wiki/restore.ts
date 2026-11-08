import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import type { WikiPage } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import { posix } from "node:path"

import type { SpaceStore } from "../persistence/spaces/store.js"
import {
  requireWikiWritePaths,
  resolveWikiWriteBoundary,
  type WikiLocationAuthority
} from "./authority.js"
import {
  commitWiki,
  isAutomatedOrigin,
  LEGACY_MAINTENANCE_ORIGIN,
  restorePage,
  type WikiCommitIdentity,
  updatePage
} from "./commit.js"
import { requireCurrent, withConflictDetail } from "./conflict.js"
import { mapRevisionError, WikiError, wikiError } from "./errors.js"
import type { WikiListingMethods } from "./listing.js"
import { normal, pageNamesForPath, writtenContent } from "./page.js"
import { loadSnapshot, notFound, type PageRecord, readRecord } from "./snapshot.js"

const restoredContent = (record: PageRecord, pageId: string) =>
  writtenContent(record.page).pipe(
    Effect.mapError((cause) => wikiError("restore", "invalid", cause.message, { pageId, cause }))
  )

interface WikiRestoreInput {
  readonly pageId: string
  readonly commitId: string
  readonly expectedVersion: string
  readonly expectedHead: string
}

interface WikiRestoreRevisionInput {
  readonly pageId: string
  readonly commitId: string
  readonly expectedVersion: string
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
  readonly commit: WikiCommitIdentity
}

interface WikiRestoreArchivedInput {
  readonly pageId: string
  readonly expectedVersion: string
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
}

export interface WikiRestoreMethods {
  readonly restore: (input: WikiRestoreInput) => Effect.Effect<WikiPage, WikiError>
  readonly restoreRevision: (input: WikiRestoreRevisionInput) => Effect.Effect<WikiPage, WikiError>
  readonly restoreArchived: (input: WikiRestoreArchivedInput) => Effect.Effect<WikiPage, WikiError>
}

export const makeWikiRestoreMethods = (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  read: WikiListingMethods["read"]
): WikiRestoreMethods => {
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
        if (current.page.lifecycle !== "active") {
          return yield* wikiError("restore", "invalid", "Only active Wiki pages can be restored", {
            pageId: input.pageId
          })
        }
        const pageHistory = yield* repository
          .history({
            resourceId: input.pageId,
            start: input.expectedHead,
            limit: null
          })
          .pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
        const maintenance = pageHistory.find((commit) => commit.commitId === input.commitId)
        if (maintenance === undefined) {
          return yield* wikiError(
            "restore",
            "not_found",
            `Maintenance commit is not a reachable page change: ${input.commitId}`,
            { pageId: input.pageId }
          )
        }
        if (maintenance.origin !== LEGACY_MAINTENANCE_ORIGIN) {
          return yield* wikiError("restore", "invalid", "Commit is not a Wiki Maintenance change", {
            pageId: input.pageId
          })
        }
        const changes = maintenance.changes.filter(
          (change) => (change.after ?? change.before)?.resourceId === input.pageId
        )
        const change = changes[0]
        if (
          changes.length !== 1 ||
          change === undefined ||
          change.action !== "update" ||
          change.before === null ||
          change.after === null
        ) {
          return yield* wikiError(
            "restore",
            "invalid",
            "Maintenance commit must contain exactly one page update",
            { pageId: input.pageId }
          )
        }
        if (
          pageHistory[0]?.commitId !== input.commitId ||
          current.resource.versionId !== change.after.versionId
        ) {
          return yield* wikiError(
            "restore",
            "conflict",
            `Wiki page changed after Maintenance commit ${input.commitId}`,
            { pageId: input.pageId }
          )
        }
        const beforeRecord = yield* readRecord(repository, "restore", change.before, "invalid")
        if (beforeRecord.page.lifecycle !== "active") {
          return yield* wikiError(
            "restore",
            "invalid",
            "Maintenance change did not replace an active page",
            {
              pageId: input.pageId
            }
          )
        }
        yield* commitWiki(
          repository,
          {
            expectedRevision: input.expectedHead,
            actor: "user:desktop",
            origin: { kind: "user", via: "desktop.restore" },
            reason: `restore Maintenance commit ${input.commitId}`
          },
          [updatePage(current.resource, yield* restoredContent(beforeRecord, input.pageId))]
        ).pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
        const page = yield* read(input.pageId).pipe(
          Effect.mapError((cause) => new WikiError({ ...cause, operation: "restore" }))
        )
        return page
      })
    )
  })

  const restoreRevision = Effect.fn("Wiki.restoreRevision")(function* (
    input: WikiRestoreRevisionInput
  ) {
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
        if (current.page.lifecycle !== "active") {
          return yield* wikiError("restore", "invalid", "Only active Wiki pages can be restored", {
            pageId: input.pageId
          })
        }
        const boundary = yield* resolveWikiWriteBoundary(
          spaces,
          input.authority,
          snapshot,
          "restore"
        )
        yield* requireWikiWritePaths(boundary, "restore", [current.resource.path])
        if (
          isAutomatedOrigin(input.commit.origin) &&
          Object.hasOwn(current.page.metadata, "producer_automation_id")
        ) {
          return yield* wikiError(
            "restore",
            "blocked",
            "Automation runs cannot restore an automation-owned page",
            { pageId: input.pageId }
          )
        }
        if (input.commit.origin.kind === "capture") {
          const spaceBound = yield* spaces
            .hasPageBinding(current.page.pageId, current.resource.path)
            .pipe(
              Effect.mapError((cause) =>
                wikiError("restore", "storage", "Could not check Memory page ownership", {
                  pageId: input.pageId,
                  cause
                })
              )
            )
          if (spaceBound) {
            return yield* wikiError(
              "restore",
              "blocked",
              "Automatic Memory cannot restore a Space-owned page",
              { pageId: input.pageId }
            )
          }
        }
        const pageHistory = yield* repository
          .history({
            resourceId: input.pageId,
            start: input.expectedHead,
            limit: null
          })
          .pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
        const selected = pageHistory.find((commit) => commit.commitId === input.commitId)
        if (selected === undefined) {
          return yield* wikiError(
            "restore",
            "not_found",
            `Revision is not a reachable page change: ${input.commitId}`,
            { pageId: input.pageId }
          )
        }
        const changes = selected.changes.filter(
          (change) => (change.after ?? change.before)?.resourceId === input.pageId
        )
        const source = changes.length === 1 ? changes[0]?.after : undefined
        if (source === undefined || source === null || source.state !== "active") {
          return yield* wikiError(
            "restore",
            "invalid",
            "Selected revision does not contain one active version of this Wiki page",
            { pageId: input.pageId }
          )
        }
        const historical = yield* readRecord(repository, "restore", source, "invalid")
        if (historical.page.lifecycle !== "active") {
          return yield* wikiError(
            "restore",
            "invalid",
            "Selected revision is not an active Wiki page",
            { pageId: input.pageId }
          )
        }
        const content = yield* restoredContent(historical, input.pageId)
        const changed = content !== current.page.content
        if (!changed) {
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
            repository,
            {
              expectedRevision: input.expectedHead,
              ...input.commit
            },
            [updatePage(current.resource, content)]
          ).pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
        }
        const page = yield* read(input.pageId).pipe(
          Effect.mapError((cause) => new WikiError({ ...cause, operation: "restore" }))
        )
        return page
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
        const boundary = yield* resolveWikiWriteBoundary(
          spaces,
          input.authority,
          snapshot,
          "restore"
        )
        yield* requireWikiWritePaths(boundary, "restore", [resource.path])
        const own = posix.dirname(resource.path)
        const directory =
          posix.basename(resource.path).toLowerCase() === "readme.md" ? posix.dirname(own) : own
        if (directory !== ".") {
          const readme = `${directory}/readme.md`.toLowerCase()
          const mapped = snapshot.pages.some(
            (record) =>
              record.resource.path.toLowerCase() === readme && record.page.lifecycle === "active"
          )
          if (!mapped) {
            return yield* wikiError(
              "restore",
              "blocked",
              `Restore the Wiki directory ${directory} first`,
              { pageId: input.pageId }
            )
          }
        }
        const names = new Set(pageNamesForPath(resource.path).map(normal))
        const taken = snapshot.pages.find((record) =>
          pageNamesForPath(record.resource.path).some((name) => names.has(normal(name)))
        )
        if (taken !== undefined) {
          return yield* wikiError(
            "restore",
            "conflict",
            `Wiki path or link name is taken by ${taken.resource.path}`,
            { pageId: input.pageId }
          )
        }
        yield* commitWiki(
          repository,
          {
            expectedRevision: input.expectedHead,
            actor: "user:desktop",
            origin: { kind: "user", via: "desktop" },
            reason: "restore archived wiki page"
          },
          [restorePage(resource)]
        ).pipe(Effect.mapError(mapRevisionError("restore", input.pageId)))
        return yield* read(input.pageId).pipe(
          Effect.mapError((cause) => new WikiError({ ...cause, operation: "restore" }))
        )
      })
    )
  })

  return { restore, restoreRevision, restoreArchived }
}
