import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import type { WikiArchiveResponse, WikiPage } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { posix } from "node:path"

import { isStandingFactsPage } from "../memory/core-memory.js"
import type { SpaceStore } from "../persistence/spaces/store.js"
import {
  authorityOwnsBoundaryPage,
  requireWikiWritePaths,
  resolveWikiWriteBoundary,
  type WikiLocationAuthority
} from "./authority.js"
import {
  archivePage,
  commitWiki,
  createPage,
  isAutomatedOrigin,
  type WikiCommitIdentity,
  type WikiCommitOrigin,
  updatePage
} from "./commit.js"
import { MONTHLY_SUMMARY_MAX_CHARS } from "./report-retention.js"
import { requireCurrent, withConflictDetail } from "./conflict.js"
import { createWikiSpacePage, type WikiSpacePageInput } from "./space-page.js"
import { makeWikiDirectoryMethods, type WikiCreateDirectoryInput } from "./directories.js"
import { mapRevisionError, WikiError, wikiError } from "./errors.js"
import type { WikiListingMethods } from "./listing.js"
import {
  formatRedirectPage,
  formatWikiPage,
  normal,
  pageNamesForPath,
  parseWikiPage
} from "./page.js"
import { publishWikiReport, type WikiPublishReportInput } from "./reports.js"
import { loadSnapshot, readRecord, type PageRecord } from "./snapshot.js"
import {
  isRetentionSummaryWrite,
  requireArchivable,
  requireRetirable,
  requireUpdatable,
  summaryTooLong
} from "./write-rules.js"

const MEMORY_CAPTURE_ORIGIN: WikiCommitOrigin = {
  kind: "capture",
  replayKey: undefined,
  sessionId: undefined
}
const DESKTOP_ORIGIN: WikiCommitOrigin = { kind: "user", via: "desktop" }

interface WikiUpdateInput {
  readonly pageId: string
  readonly content: string
  readonly expectedVersion: string
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
  readonly commit?: WikiCommitIdentity
}

interface WikiCreateInput {
  readonly path: string
  readonly title: string
  readonly body: string
  readonly authority: WikiLocationAuthority
  readonly commit?: WikiCommitIdentity
}

interface WikiCreateDirectoryResult {
  readonly page: WikiPage
  readonly changed: boolean
  readonly adopted: boolean
}

interface WikiArchiveInput {
  readonly pageId: string
  readonly expectedVersion: string
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
  readonly commit?: WikiCommitIdentity
}

export interface WikiMutationMethods {
  readonly create: (input: WikiCreateInput) => Effect.Effect<WikiPage, WikiError>
  readonly createDirectory: (
    input: WikiCreateDirectoryInput
  ) => Effect.Effect<WikiCreateDirectoryResult, WikiError>
  readonly createSpacePage: (input: WikiSpacePageInput) => Effect.Effect<WikiPage, WikiError>
  readonly publishReport: (input: WikiPublishReportInput) => Effect.Effect<
    {
      readonly page: WikiPage
      readonly changed: boolean
    },
    WikiError
  >
  readonly update: (input: WikiUpdateInput) => Effect.Effect<WikiPage, WikiError>
  readonly archive: (input: WikiArchiveInput) => Effect.Effect<WikiArchiveResponse, WikiError>
  readonly mergeInto: (
    input: WikiArchiveInput & { readonly targetPageId: string }
  ) => Effect.Effect<WikiPage, WikiError>
}

/**
 * Why a page may not be created at `path`, if it may not: a page is a .md file inside an
 * existing directory, or a standing-facts page at the root; a README is never created this way.
 */
export const createRefusal = (
  path: string
): { readonly code: "invalid" | "blocked"; readonly message: string } | undefined => {
  if (!path.endsWith(".md")) return { code: "invalid", message: "Wiki page paths must end in .md" }
  if (
    (posix.dirname(path) === "." && !isStandingFactsPage({ path, pageId: "" })) ||
    posix.basename(path).toLowerCase() === "readme.md"
  )
    return {
      code: "blocked",
      message: "Wiki pages can be created only inside an existing Wiki directory"
    }
  return undefined
}

export const makeWikiMutationMethods = (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  read: WikiListingMethods["read"]
): WikiMutationMethods => {
  const create = Effect.fn("Wiki.create")(function* (input: WikiCreateInput) {
    const refused = createRefusal(input.path)
    if (refused !== undefined) return yield* wikiError("create", refused.code, refused.message)
    const directory = posix.dirname(input.path)
    const pageId = randomUUID()
    const content = formatWikiPage({
      pageId,
      title: input.title,
      aliases: [],
      lifecycle: "active",
      redirectTo: null,
      metadata: {},
      body: input.body
    })
    yield* parseWikiPage(content, pageId).pipe(
      Effect.mapError((cause) => wikiError("create", "invalid", cause.message, { pageId, cause }))
    )
    const current = yield* loadSnapshot(repository, "create")
    const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, current, "create")
    yield* requireWikiWritePaths(boundary, "create", [input.path])
    const directoryPage = current.pages.find(
      (record) =>
        record.resource.path.toLowerCase() ===
          (directory === "." ? "readme.md" : `${directory}/readme.md`).toLowerCase() &&
        record.page.lifecycle === "active"
    )
    if (directoryPage === undefined) {
      return yield* wikiError("create", "blocked", `Wiki directory is not mapped: ${directory}`)
    }
    const origin = input.commit?.origin ?? MEMORY_CAPTURE_ORIGIN
    // Report Retention writes the one monthly summary that replaces a month of reports.
    const writesMonthlySummary = isRetentionSummaryWrite(origin, input.path)
    if (writesMonthlySummary && input.body.length > MONTHLY_SUMMARY_MAX_CHARS) {
      return yield* wikiError("create", "invalid", summaryTooLong(input.body.length))
    }
    if (
      Object.hasOwn(directoryPage.page.metadata, "producer_automation_id") &&
      isAutomatedOrigin(origin) &&
      !writesMonthlySummary
    ) {
      return yield* wikiError(
        "create",
        "blocked",
        "Automation pages in an owned directory must use report publication"
      )
    }
    const directoryIsSpaceBound = yield* spaces
      .hasPageBinding(directoryPage.page.pageId, directoryPage.resource.path)
      .pipe(
        Effect.mapError((cause) =>
          wikiError("create", "storage", "Could not check Memory directory ownership", {
            pageId: directoryPage.page.pageId,
            cause
          })
        )
      )
    if (
      directoryIsSpaceBound &&
      !authorityOwnsBoundaryPage(boundary, directoryPage.page.pageId, directoryPage.resource.path)
    ) {
      return yield* wikiError(
        "create",
        "blocked",
        "Pages cannot be created inside a Space-owned directory"
      )
    }
    const targetNames = new Set(pageNamesForPath(input.path).map((name) => normal(name)))
    const existing = current.pages.find((record) =>
      pageNamesForPath(record.resource.path).some((name) => targetNames.has(normal(name)))
    )
    if (existing !== undefined) {
      return yield* wikiError(
        "create",
        "conflict",
        `Wiki path or link name already exists: ${input.path}`,
        {
          pageId: existing.page.pageId
        }
      )
    }
    yield* commitWiki(
      repository,
      {
        expectedRevision: current.head,
        actor: input.commit?.actor ?? "memory:capture",
        origin: input.commit?.origin ?? MEMORY_CAPTURE_ORIGIN,
        reason: input.commit?.reason ?? "create Memory page"
      },
      [createPage(pageId, input.path, content)]
    ).pipe(Effect.mapError(mapRevisionError("create", pageId)))
    const page = yield* read(pageId).pipe(
      Effect.mapError((cause) => new WikiError({ ...cause, operation: "create" }))
    )
    return page
  })

  const directoryMethods = makeWikiDirectoryMethods(repository, spaces)
  const createDirectory = Effect.fn("Wiki.createDirectory")(function* (
    input: WikiCreateDirectoryInput
  ) {
    const created = yield* directoryMethods.createDirectory(input)
    const page = yield* read(created.pageId).pipe(
      Effect.mapError((cause) => new WikiError({ ...cause, operation: "create" }))
    )
    return { page, changed: created.changed, adopted: created.adopted }
  })

  const createSpacePage = Effect.fn("Wiki.createSpacePage")(function* (input: WikiSpacePageInput) {
    const pageId = yield* createWikiSpacePage(repository, spaces, input)
    const page = yield* read(pageId).pipe(
      Effect.mapError((cause) => new WikiError({ ...cause, operation: "create" }))
    )
    return page
  })

  const publishReport = Effect.fn("Wiki.publishReportAndNotify")(function* (
    input: WikiPublishReportInput
  ) {
    const result = yield* publishWikiReport(repository, spaces, input)
    const page = yield* read(result.pageId)
    return { page, changed: result.changed }
  })

  const update = Effect.fn("Wiki.update")(function* (input: WikiUpdateInput) {
    return yield* withConflictDetail(
      repository,
      Effect.gen(function* () {
        const snapshot = yield* loadSnapshot(repository, "update")
        const current = yield* requireCurrent(
          "update",
          snapshot,
          input.pageId,
          input.expectedVersion,
          input.expectedHead
        )
        const content = yield* requireUpdatable(spaces, snapshot, current, input)
        const changed = content !== current.page.content
        if (!changed) {
          const latestHead = yield* repository.currentRevision.pipe(
            Effect.mapError(mapRevisionError("update", input.pageId))
          )
          if (latestHead !== snapshot.head) {
            return yield* wikiError("update", "conflict", "Wiki changed during the update", {
              pageId: input.pageId
            })
          }
        } else {
          yield* commitWiki(
            repository,
            {
              actor: input.commit?.actor ?? "user:desktop",
              origin: input.commit?.origin ?? DESKTOP_ORIGIN,
              reason: input.commit?.reason ?? "update wiki page",
              expectedRevision: input.expectedHead
            },
            [updatePage(current.resource, content)]
          ).pipe(Effect.mapError(mapRevisionError("update", input.pageId)))
        }
        const page = yield* read(input.pageId).pipe(
          Effect.mapError((cause) =>
            cause.reason === "not_found"
              ? wikiError("update", "corrupt", "Updated Wiki page disappeared", {
                  pageId: input.pageId,
                  cause
                })
              : new WikiError({ ...cause, operation: "update" })
          )
        )
        return page
      })
    )
  })

  /**
   * A page that was merged and then brought back is separate by someone's decision. An
   * automated run that merged it again would undo that decision every time it ran.
   */
  const requireNeverUnmerged = Effect.fn("Wiki.requireNeverUnmerged")(function* (
    current: PageRecord,
    head: string
  ): Effect.fn.Return<void, WikiError> {
    const pageId = current.page.pageId
    const history = yield* repository
      .history({ resourceId: pageId, start: head, limit: null })
      .pipe(Effect.mapError(mapRevisionError("merge", pageId)))
    for (const commit of history) {
      const version = commit.changes.find(
        (change) => (change.after ?? change.before)?.resourceId === pageId
      )?.after
      if (version === undefined || version === null || version.state !== "active") continue
      const earlier = yield* readRecord(repository, "merge", version)
      if (earlier.page.lifecycle === "redirect") {
        return yield* wikiError(
          "merge",
          "blocked",
          `${current.resource.path} was merged before and then restored, so it stays its own page. Leave it.`,
          { pageId }
        )
      }
    }
  })

  const archive = Effect.fn("Wiki.archive")(function* (
    input: WikiArchiveInput
  ): Effect.fn.Return<WikiArchiveResponse, WikiError> {
    return yield* withConflictDetail(
      repository,
      Effect.gen(function* () {
        const snapshot = yield* loadSnapshot(repository, "archive")
        const current = yield* requireCurrent(
          "archive",
          snapshot,
          input.pageId,
          input.expectedVersion,
          input.expectedHead
        )
        yield* requireArchivable(spaces, snapshot, current, input)
        const committed = yield* commitWiki(
          repository,
          {
            actor: input.commit?.actor ?? "user:desktop",
            origin: input.commit?.origin ?? DESKTOP_ORIGIN,
            reason: input.commit?.reason ?? "archive wiki page",
            expectedRevision: input.expectedHead
          },
          [archivePage(current.resource)]
        ).pipe(Effect.mapError(mapRevisionError("archive", input.pageId)))
        const archived = committed.commit.changes.find(
          (change) => change.after?.resourceId === input.pageId
        )?.after
        if (archived === undefined || archived === null || archived.state !== "archived") {
          return yield* wikiError("archive", "corrupt", "Archive commit did not contain the page", {
            pageId: input.pageId
          })
        }
        return {
          pageId: input.pageId,
          path: archived.path,
          resourceState: "archived" as const,
          version: archived.versionId,
          repositoryHead: committed.commit.commitId
        }
      })
    )
  })

  const mergeInto = Effect.fn("Wiki.mergeInto")(function* (
    input: WikiArchiveInput & { readonly targetPageId: string }
  ): Effect.fn.Return<WikiPage, WikiError> {
    return yield* withConflictDetail(
      repository,
      Effect.gen(function* () {
        const snapshot = yield* loadSnapshot(repository, "merge")
        const current = yield* requireCurrent(
          "merge",
          snapshot,
          input.pageId,
          input.expectedVersion,
          input.expectedHead
        )
        yield* requireRetirable(spaces, "merge", snapshot, current, input)
        if (input.commit !== undefined && isAutomatedOrigin(input.commit.origin)) {
          yield* requireNeverUnmerged(current, input.expectedHead)
        }
        const target = snapshot.pages.find(
          (record) =>
            record.page.pageId === input.targetPageId && record.page.lifecycle === "active"
        )
        if (target === undefined || target.page.pageId === input.pageId) {
          return yield* wikiError(
            "merge",
            "invalid",
            "A page merges only into another active Wiki page",
            { pageId: input.pageId }
          )
        }
        yield* commitWiki(
          repository,
          {
            actor: input.commit?.actor ?? "user:desktop",
            origin: input.commit?.origin ?? DESKTOP_ORIGIN,
            reason:
              input.commit?.reason ??
              `merge wiki page ${current.resource.path} into ${target.resource.path}`,
            expectedRevision: input.expectedHead
          },
          [
            updatePage(
              current.resource,
              formatRedirectPage({
                pageId: current.page.pageId,
                title: current.page.title,
                redirectTo: target.page.pageId
              })
            )
          ]
        ).pipe(Effect.mapError(mapRevisionError("merge", input.pageId)))
        return yield* read(target.page.pageId).pipe(
          Effect.mapError((cause) => new WikiError({ ...cause, operation: "merge" }))
        )
      })
    )
  })

  return {
    create,
    createDirectory,
    createSpacePage,
    publishReport,
    update,
    archive,
    mergeInto
  }
}
