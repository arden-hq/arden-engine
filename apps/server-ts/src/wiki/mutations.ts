import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import type { WikiArchiveResponse, WikiPage } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { posix } from "node:path"

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
  encodeWikiOrigin,
  isAutomatedOrigin,
  type WikiCommitIdentity,
  type WikiCommitOrigin,
  updatePage
} from "./commit.js"
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
  parseWikiPage,
  writtenContent
} from "./page.js"
import { publishWikiReport, type WikiPublishReportInput } from "./reports.js"
import { followRedirect, loadSnapshot, type PageRecord, type Snapshot } from "./snapshot.js"

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
  readonly observe: () => Effect.Effect<string | null, WikiError>
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

export const makeWikiMutationMethods = (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  read: WikiListingMethods["read"]
): WikiMutationMethods => {
  const observe = Effect.fn("Wiki.observe")(function* () {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const preview = yield* repository.previewWorkingChanges.pipe(
        Effect.mapError(mapRevisionError("observe"))
      )
      if (preview.changes.length === 0) return preview.revision
      const current = yield* loadSnapshot(repository, "observe")
      if (current.head !== preview.revision) continue
      const byId = new Map(current.pages.map((record) => [record.page.pageId, record] as const))
      for (const change of preview.changes) {
        const record = byId.get(change.resourceId)
        if (
          record === undefined ||
          record.resource.path !== change.path ||
          record.resource.versionId !== change.expectedVersion ||
          record.page.lifecycle !== "active"
        ) {
          return yield* wikiError(
            "observe",
            "conflict",
            `External Wiki edit does not match an active tracked page: ${change.path}`,
            { pageId: change.resourceId }
          )
        }
        const content = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(change.content),
          catch: (cause) =>
            wikiError("observe", "invalid", "External Wiki edit must be valid UTF-8", {
              pageId: change.resourceId,
              cause
            })
        })
        const parsed = yield* parseWikiPage(content, change.resourceId).pipe(
          Effect.mapError((cause) =>
            wikiError("observe", "invalid", cause.message, {
              pageId: change.resourceId,
              cause
            })
          )
        )
        if (parsed.lifecycle !== "active") {
          return yield* wikiError(
            "observe",
            "invalid",
            "External Wiki edits cannot change page lifecycle",
            { pageId: change.resourceId }
          )
        }
      }
      const adopted = yield* repository
        .adoptWorkingChanges(preview, {
          actor: "user:external",
          origin: encodeWikiOrigin({ kind: "user", via: "filesystem" }),
          reason: "adopt external Wiki edits"
        })
        .pipe(Effect.mapError(mapRevisionError("observe")))
      return adopted.commit.commitId
    }
    return yield* wikiError(
      "observe",
      "conflict",
      "Wiki changed while external edits were observed"
    )
  })

  const create = Effect.fn("Wiki.create")(function* (input: WikiCreateInput) {
    if (!input.path.endsWith(".md")) {
      return yield* wikiError("create", "invalid", "Wiki page paths must end in .md")
    }
    if (input.path.toLowerCase() === "health.md") {
      return yield* wikiError("create", "blocked", "Wiki health is backend-managed")
    }
    const directory = posix.dirname(input.path)
    if (
      (directory === "." && input.path !== "me.md") ||
      posix.basename(input.path).toLowerCase() === "readme.md"
    ) {
      return yield* wikiError(
        "create",
        "blocked",
        "Wiki pages can be created only inside an existing Wiki directory"
      )
    }
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
    if (
      Object.hasOwn(directoryPage.page.metadata, "producer_automation_id") &&
      isAutomatedOrigin(input.commit?.origin ?? MEMORY_CAPTURE_ORIGIN)
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
        if (current.page.lifecycle !== "active") {
          return yield* wikiError("update", "invalid", "Only active Wiki pages can be updated", {
            pageId: input.pageId
          })
        }
        if (current.resource.path.toLowerCase() === "health.md") {
          return yield* wikiError("update", "blocked", "Wiki health is backend-managed", {
            pageId: input.pageId
          })
        }
        const boundary = yield* resolveWikiWriteBoundary(
          spaces,
          input.authority,
          snapshot,
          "update"
        )
        yield* requireWikiWritePaths(boundary, "update", [current.resource.path])
        const replacement = yield* parseWikiPage(input.content, input.pageId).pipe(
          Effect.mapError((cause) =>
            wikiError("update", "invalid", cause.message, {
              pageId: input.pageId,
              cause
            })
          )
        )
        if (replacement.lifecycle !== "active") {
          return yield* wikiError("update", "invalid", "A page update cannot create a redirect", {
            pageId: input.pageId
          })
        }
        const content = yield* writtenContent(replacement).pipe(
          Effect.mapError((cause) =>
            wikiError("update", "invalid", cause.message, { pageId: input.pageId, cause })
          )
        )
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

  const requireRetirable = Effect.fn("Wiki.requireRetirable")(function* (
    operation: "archive" | "merge",
    snapshot: Snapshot,
    current: PageRecord,
    input: WikiArchiveInput
  ): Effect.fn.Return<void, WikiError> {
    if (current.page.lifecycle !== "active") {
      return yield* wikiError(operation, "invalid", "Only active Wiki pages can be retired", {
        pageId: input.pageId
      })
    }
    const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, operation)
    yield* requireWikiWritePaths(boundary, operation, [current.resource.path])
    if (
      input.commit !== undefined &&
      isAutomatedOrigin(input.commit.origin) &&
      Object.hasOwn(current.page.metadata, "producer_automation_id")
    ) {
      return yield* wikiError(
        operation,
        "blocked",
        "Automation runs cannot archive an automation-owned page",
        { pageId: input.pageId }
      )
    }
    const pageIsSpaceBound = yield* spaces.hasPageBinding(input.pageId, current.resource.path).pipe(
      Effect.mapError((cause) =>
        wikiError(operation, "storage", "Could not check Space page ownership", {
          pageId: input.pageId,
          cause
        })
      )
    )
    if (pageIsSpaceBound) {
      return yield* wikiError(
        operation,
        "blocked",
        "A Space owns this Wiki page; move or archive the Space first",
        { pageId: input.pageId }
      )
    }
    if (posix.basename(current.resource.path).toLowerCase() === "readme.md") {
      const directory = posix.dirname(current.resource.path)
      const prefix = `${directory}/`
      const child = snapshot.pages.find(
        (record) =>
          record.page.pageId !== input.pageId &&
          record.page.lifecycle === "active" &&
          record.resource.path.startsWith(prefix)
      )
      if (child !== undefined) {
        return yield* wikiError(operation, "blocked", `Active Wiki pages remain in ${directory}`, {
          pageId: input.pageId
        })
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
        yield* requireRetirable("archive", snapshot, current, input)
        const remaining = snapshot.pages.filter((record) => record.page.pageId !== input.pageId)
        const remainingById = new Map(
          remaining.map((record) => [record.page.pageId, record] as const)
        )
        const brokenRedirect = remaining.find(
          (record) =>
            record.page.lifecycle === "redirect" &&
            followRedirect(remainingById, record.page.pageId) === null
        )
        if (brokenRedirect !== undefined) {
          return yield* wikiError(
            "archive",
            "invalid",
            `Page is still the target of redirect ${brokenRedirect.page.pageId}`,
            { pageId: input.pageId }
          )
        }
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
        yield* requireRetirable("merge", snapshot, current, input)
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
    observe,
    create,
    createDirectory,
    createSpacePage,
    publishReport,
    update,
    archive,
    mergeInto
  }
}
